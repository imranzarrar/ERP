#!/usr/bin/env node
// Static heuristic check for missing company/branch ownership checks in server/routes/*.ts.
//
// Three real bug classes found this project's isolation audits (BACKLOG.md items 95-97)
// share one exact shape: a foreign-key-looking field (customerId, vendorId, productId,
// warehouseId, bankId, branchId, ...) is read STRAIGHT FROM THE CLIENT (req.body, or an
// object/array derived from it with no DB round-trip in between) and used in a
// db.insert/db.update with no check that the row it points at belongs to
// req.targetCompanyId (or, for branch-scoped tables, req.allowedBranchIds). This script
// traces exactly that shape — client input flowing untouched into a write — via a simple
// taint-tracking pass, not a general data-flow prover. See
// .claude/skills/data-isolation-guard/SKILL.md for when/how to run it and how to read a
// finding.
//
// Deliberately narrow scope, by design: a value that passed through even one DB
// round-trip (e.g. `expense.bankId`, fetched from an already-scoped `expense` row) is NOT
// flagged, even though that select might itself be unscoped in some rare case — tracing
// that accurately needs real data-flow analysis this script doesn't attempt. This keeps
// the signal-to-noise ratio usable: it catches the exact "raw client input straight into
// a write" pattern that caused every real bug found this session, and stays quiet about
// everything else rather than drowning that signal in speculative noise.
//
// Usage: node scripts/check-data-isolation.mjs [--json]

import ts from 'typescript';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ROUTES_DIR = path.join(ROOT, 'server', 'routes');

// Every helper this codebase already uses to assert a foreign-key field belongs to the
// caller's own company or branch. If a new one is added, add its name here too.
const OWNERSHIP_HELPERS = [
  'assertOwnsRow',
  'assertDocumentRefsOwnedByCompany',
  'assertProductsOwnedByCompany',
  'branchAccessOk',
  'branchAccessOkViaWarehouse',
  'resolveDocumentBranchId',
];

// A same-handler comment naming the field silences a finding — for a case that's
// genuinely already safe but not in a shape this script traces (e.g. an unusual
// indirection). Keep these honest, not a way to make noise disappear.
const SUPPRESS_COMMENT = /isolation-(ok|checked)\s*:/i;

// Field names this codebase already documents (src/db/schema.ts) as deliberately
// polymorphic — no single-table FK is possible, so no single ownership check applies.
const KNOWN_POLYMORPHIC_FIELDS = new Set(['referenceId', 'entityId']);

// Fields that end in "Id" but, per src/db/schema.ts's own column definitions (confirmed
// via a full FK audit — BACKLOG.md item 93), are plain identifier/label strings, not row
// references at all: companies.themeId (a theme name, text), recurringPostings.monthId
// (a "YYYY-MM" string sharing fiscalMonths' id format by convention, explicitly commented
// in schema.ts as "intentionally excluded" from real FK treatment).
const KNOWN_NON_FK_ID_FIELDS = new Set(['themeId', 'monthId']);

// Tables with no companyId column at all, by deliberate design (translations is a
// global, shared-across-every-tenant UI dictionary — see its own schema.ts comment).
// A handler that only ever touches these needs no company-ownership check.
const COMPANYLESS_TABLES = ['schema.translations'];

// Property/identifier names never worth flagging regardless of taint.
const ALWAYS_SAFE_NAMES = new Set(['id', 'companyId']); // companyId checked separately below

function findRouteHandlers(sourceFile) {
  const handlers = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'router' &&
      ['get', 'post', 'put', 'patch', 'delete'].includes(node.expression.name.text)
    ) {
      const lastArg = node.arguments[node.arguments.length - 1];
      if (lastArg && (ts.isArrowFunction(lastArg) || ts.isFunctionExpression(lastArg))) {
        const pathArg = node.arguments[0];
        const routePath = pathArg && ts.isStringLiteral(pathArg) ? pathArg.text : '(dynamic)';
        handlers.push({
          method: node.expression.name.text,
          routePath,
          node: lastArg,
          start: lastArg.getStart(sourceFile),
          end: lastArg.getEnd(),
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return handlers;
}

function findWriteCalls(handlerNode) {
  const writes = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'values' || node.expression.name.text === 'set')
    ) {
      let base = node.expression.expression;
      let kind = null;
      while (base) {
        if (ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression)) {
          const name = base.expression.name.text;
          if (name === 'insert') { kind = 'insert'; break; }
          if (name === 'update') { kind = 'update'; break; }
          base = base.expression.expression;
        } else if (ts.isPropertyAccessExpression(base)) {
          base = base.expression;
        } else break;
      }
      if (kind) writes.push({ kind, argNode: node.arguments[0], callNode: node });
    }
    ts.forEachChild(node, visit);
  }
  visit(handlerNode);
  return writes;
}

// Finds `const <name> = <initializer>;` within handlerNode and returns the initializer
// expression node — lets extractProps see through the extremely common
// `const itemRows = data.items.map(...); ...values(itemRows)` shape, where the write
// call's own argument is a bare identifier, not an inline literal.
function resolveIdentifierDeclaration(handlerNode, name, sourceFile) {
  let found = null;
  function visit(node) {
    if (found) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(handlerNode);
  return found;
}

function extractProps(argNode, sourceFile, handlerNode, depth = 0) {
  const props = [];
  function fromObjectLiteral(obj) {
    for (const prop of obj.properties) {
      if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
        props.push({ name: prop.name.text, valueText: prop.initializer.getText(sourceFile).trim() });
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        props.push({ name: prop.name.text, valueText: prop.name.text });
      }
    }
  }
  if (!argNode) return props;
  // A bare identifier argument (e.g. `.values(itemRows)`) — resolve to its own
  // declaration in the same handler and recurse into that instead. Depth-limited to
  // avoid any pathological cycle; real code never needs more than one hop here.
  if (ts.isIdentifier(argNode) && handlerNode && depth < 4) {
    const resolved = resolveIdentifierDeclaration(handlerNode, argNode.text, sourceFile);
    if (resolved) return extractProps(resolved, sourceFile, handlerNode, depth + 1);
    return props;
  }
  if (ts.isObjectLiteralExpression(argNode)) {
    fromObjectLiteral(argNode);
  } else if (ts.isArrayLiteralExpression(argNode)) {
    for (const el of argNode.elements) {
      if (ts.isObjectLiteralExpression(el)) fromObjectLiteral(el);
    }
  } else if (ts.isCallExpression(argNode)) {
    const cb = argNode.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
    if (cb) {
      let body = cb.body;
      if (ts.isParenthesizedExpression(body)) body = body.expression;
      if (ts.isObjectLiteralExpression(body)) fromObjectLiteral(body);
    }
  }
  return props;
}

function isFkShaped(name) {
  return /Id$/.test(name) && !ALWAYS_SAFE_NAMES.has(name) && !KNOWN_NON_FK_ID_FIELDS.has(name);
}

// A handler satisfies the "is companyId ever actually enforced here" question if it
// either references req.targetCompanyId directly, calls one of the shared ownership
// helpers (every one of which uses req.targetCompanyId/req.allowedBranchIds internally —
// the literal text just doesn't appear in the CALLING handler), scopes its write purely
// to the caller's own row via req.user.id (no company concept needed for "edit my own
// record"), or only touches a table that has no companyId column at all by design.
function handlerHasCompanyCheck(handlerText) {
  if (/req\.targetCompanyId/.test(handlerText)) return true;
  if (OWNERSHIP_HELPERS.some((h) => handlerText.includes(h + '('))) return true;
  if (/eq\(schema\.\w+\.id,\s*req\.user\.id\)/.test(handlerText)) return true;
  if (COMPANYLESS_TABLES.some((t) => handlerText.includes(t))) return true;
  // A route whose ONLY door is "must be a super-admin" is a genuine, deliberate exception
  // (platform-owner actions — creating/overwriting a company row itself, etc.) — a
  // super-admin is definitionally allowed to act on any company, so no per-request
  // targetCompanyId scoping applies. Approximated as: the super-admin gate appears, and
  // no OTHER role (isCompanyAdmin / a second hasPermission branch) is also accepted —
  // if it were, that other caller WOULD need real company scoping and this exemption
  // must not apply.
  if (/if\s*\(\s*!isSuperAdminUser\(req\.user\)\s*\)/.test(handlerText) && !/isCompanyAdmin/.test(handlerText)) return true;
  return false;
}

// Collects the set of identifier names that are, directly or transitively within this
// handler, bound to something derived from req.body with no DB round-trip in between.
// Approximated via a few fixed-point passes over variable declarations and destructuring
// patterns — not full scope-aware symbol resolution, but effective for this codebase's
// consistent style (a small number of well-known shapes, see file header).
// Returns { tainted: Set<name>, provenance: Map<name, Set<originalName>> } — provenance
// tracks which *directly* req.body-bound name(s) each tainted name ultimately derives
// from, so a fallback/coalesce variable (`const targetX = customX || existing.x;`) can
// still be matched against a check written against the ORIGINAL name (`customX`) even
// though the derived variable has a different name entirely.
function collectTaintedNames(handlerNode, sourceFile) {
  const tainted = new Set(['req.body']); // sentinel; real names added below
  const provenance = new Map(); // name -> Set(original directly-tainted names)
  const declarations = []; // {names: string[], initializerText: string}

  function bindingNames(nameNode) {
    const names = [];
    if (ts.isIdentifier(nameNode)) {
      names.push(nameNode.text);
    } else if (ts.isObjectBindingPattern(nameNode)) {
      for (const el of nameNode.elements) {
        if (ts.isIdentifier(el.name)) names.push(el.name.text);
        else names.push(...bindingNames(el.name));
      }
    } else if (ts.isArrayBindingPattern(nameNode)) {
      for (const el of nameNode.elements) {
        if (ts.isBindingElement(el)) names.push(...bindingNames(el.name));
      }
    }
    return names;
  }

  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      declarations.push({
        names: bindingNames(node.name),
        text: node.initializer.getText(sourceFile),
        // A DB round-trip (a real .select()/.insert()/.update() call against Drizzle)
        // legitimately breaks taint even when a tainted value was used as its lookup
        // key — using client input to look a row up is exactly what makes the result
        // trustworthy, not what makes it suspect. Without this, `const [template] =
        // await tx.select()...where(eq(id, templateId))` would be wrongly tainted just
        // because `templateId` (client-supplied) appears inside the WHERE clause.
        isDbRoundTrip: /\.(select|insert|update)\s*\(/.test(node.initializer.getText(sourceFile)),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(handlerNode);

  function propagate(name, sourceSet) {
    if (!tainted.has(name)) tainted.add(name);
    const existing = provenance.get(name) || new Set();
    for (const s of sourceSet) existing.add(s);
    provenance.set(name, existing);
  }

  // Fixed point: a declaration taints its bound names if its initializer text contains
  // "req.body" directly (provenance = the names themselves), OR contains (as a whole
  // word) any name already known tainted (provenance = that name's own provenance,
  // carried forward — this is what lets a fallback like
  // `const targetX = customX || existing.x;` still be matched against a check written
  // against the original `customX`) — UNLESS the initializer is a DB round-trip.
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 6) {
    changed = false;
    iterations++;
    for (const decl of declarations) {
      if (decl.isDbRoundTrip) continue;
      const alreadyTainted = decl.names.every((n) => tainted.has(n));
      if (alreadyTainted) continue;
      if (/req\.body/.test(decl.text)) {
        for (const n of decl.names) { propagate(n, [n]); changed = true; }
        continue;
      }
      const matchedSources = [...tainted].filter(
        (t) => t !== 'req.body' && new RegExp('\\b' + escapeRe(t) + '\\b').test(decl.text)
      );
      if (matchedSources.length > 0) {
        const combinedProvenance = new Set();
        for (const src of matchedSources) {
          for (const p of provenance.get(src) || [src]) combinedProvenance.add(p);
        }
        for (const n of decl.names) { propagate(n, combinedProvenance); changed = true; }
      }
    }
  }

  // .map((param) => (...)) where the array being mapped is itself tainted (e.g.
  // `xData.items.map((item) => ({...}))`) taints the callback's own parameter name,
  // carrying forward the same provenance.
  function visitMaps(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'map'
    ) {
      const arrayExprText = node.expression.expression.getText(sourceFile);
      const matchedSources = [...tainted].filter(
        (t) => t !== 'req.body' && new RegExp('\\b' + escapeRe(t) + '\\b').test(arrayExprText)
      );
      const arrayIsTainted = /req\.body/.test(arrayExprText) || matchedSources.length > 0;
      if (arrayIsTainted) {
        const combinedProvenance = new Set();
        if (/req\.body/.test(arrayExprText)) combinedProvenance.add(arrayExprText);
        for (const src of matchedSources) {
          for (const p of provenance.get(src) || [src]) combinedProvenance.add(p);
        }
        const cb = node.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
        if (cb) {
          for (const p of cb.parameters) {
            if (ts.isIdentifier(p.name)) propagate(p.name.text, combinedProvenance);
          }
        }
      }
    }
    ts.forEachChild(node, visitMaps);
  }
  visitMaps(handlerNode);

  tainted.delete('req.body');
  provenance.delete('req.body');
  return { tainted, provenance };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Given a write-payload value expression's source text, return {root, searchTerm} — root
// is the base identifier (for taint lookup), searchTerm is what to look for in ownership
// checks (the trailing property name for a.b forms, else the identifier itself).
function analyzeValueExpr(valueText) {
  const simple = /^[A-Za-z_$][\w$]*$/;
  const dotted = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/;
  if (simple.test(valueText)) return { root: valueText, searchTerm: valueText };
  if (dotted.test(valueText)) {
    const parts = valueText.split('.');
    return { root: parts[0], searchTerm: parts[parts.length - 1] };
  }
  return null; // complex expression (ternary, call, etc.) — not traced, not flagged
}

function handlerChecksField(handlerText, searchTerm) {
  for (const helper of OWNERSHIP_HELPERS) {
    const re = new RegExp(helper + '\\s*\\([^;]*?\\b' + escapeRe(searchTerm) + '\\b[^;]*?\\)', 's');
    if (re.test(handlerText)) return true;
  }
  const idRefRe = new RegExp('eq\\(schema\\.\\w+\\.id,[^)]*\\b' + escapeRe(searchTerm) + '\\b', 'g');
  let m;
  while ((m = idRefRe.exec(handlerText))) {
    const windowStart = Math.max(0, m.index - 300);
    const windowEnd = Math.min(handlerText.length, m.index + 300);
    if (/eq\(schema\.\w+\.companyId,/.test(handlerText.slice(windowStart, windowEnd))) return true;
  }
  const lines = handlerText.split('\n');
  if (lines.some((l) => SUPPRESS_COMMENT.test(l) && l.includes(searchTerm))) return true;
  return false;
}

function checkFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const handlers = findRouteHandlers(sourceFile);
  const findings = [];

  // A file-wide `router.use((req, res, next) => { ... req.targetCompanyId ... })` (e.g.
  // zatca.ts's shared admin/company-mismatch gate) protects every route registered on
  // that router, even though the literal text never appears in each individual handler.
  // Approximated at file granularity (ignoring exact declaration order) rather than
  // precisely modeling Express's sequential middleware application — acceptable here
  // since every such gate in this codebase is declared before the routes it protects.
  const fileHasCompanyGateMiddleware = /router\.use\(/.test(text) && /router\.use\([^]*?req\.targetCompanyId/.test(text);

  for (const handler of handlers) {
    const handlerText = text.slice(handler.start, handler.end);
    const { tainted, provenance } = collectTaintedNames(handler.node, sourceFile);
    const writes = findWriteCalls(handler.node);
    const seenInHandler = new Set();

    for (const write of writes) {
      const props = extractProps(write.argNode, sourceFile, handler.node);
      for (const { name, valueText } of props) {
        if (!isFkShaped(name) || KNOWN_POLYMORPHIC_FIELDS.has(name)) continue;
        const analyzed = analyzeValueExpr(valueText);
        if (!analyzed) continue; // complex expression — not traced
        // A trailing `.id` access is a reference to whatever row/object is already in
        // scope's own primary key (the entity being created/edited, or an already
        // company-scoped fetch) — never a foreign lookup needing its own ownership check.
        if (analyzed.searchTerm === 'id') continue;
        if (!tainted.has(analyzed.root)) continue; // not traceable to req.body — skip
        // For a bare-identifier value (e.g. `targetTaxSlabId`), also try every original
        // req.body-bound name it can be traced back to — this is what lets a fallback/
        // coalesce variable (`targetX = customX || existing.x`) match a check written
        // against the ORIGINAL name `customX`. For a dotted value (`poData.vendorId`),
        // the root (`poData`) is just a namespace/container, not itself a meaningful
        // search term — including it would trivially "match" any unrelated scoped check
        // elsewhere in the handler that happens to touch a DIFFERENT property of the same
        // container object. Only the trailing property name (already `searchTerm`) means
        // anything for a dotted value.
        const isDotted = valueText.includes('.');
        const candidates = isDotted
          ? new Set([analyzed.searchTerm])
          : new Set([analyzed.searchTerm, ...(provenance.get(analyzed.root) || [])]);
        if (seenInHandler.has(analyzed.searchTerm)) continue;
        if (![...candidates].some((c) => handlerChecksField(handlerText, c))) {
          seenInHandler.add(analyzed.searchTerm);
          const pos = sourceFile.getLineAndCharacterOfPosition(write.callNode.getStart(sourceFile));
          findings.push({
            file: path.relative(ROOT, filePath).replace(/\\/g, '/'),
            line: pos.line + 1,
            route: `${handler.method.toUpperCase()} ${handler.routePath}`,
            field: name,
            valueText,
            kind: write.kind,
          });
        }
      }
    }

    if (writes.length > 0 && !handlerHasCompanyCheck(handlerText) && !fileHasCompanyGateMiddleware) {
      findings.push({
        file: path.relative(ROOT, filePath).replace(/\\/g, '/'),
        line: handler.line,
        route: `${handler.method.toUpperCase()} ${handler.routePath}`,
        field: 'companyId',
        kind: 'missing-target-company',
      });
    }
  }
  return findings;
}

function main() {
  const jsonOutput = process.argv.includes('--json');
  const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts')).map((f) => path.join(ROUTES_DIR, f));
  let allFindings = [];
  for (const file of files) allFindings = allFindings.concat(checkFile(file));

  if (jsonOutput) {
    console.log(JSON.stringify(allFindings, null, 2));
    process.exit(allFindings.length > 0 ? 1 : 0);
  }

  if (allFindings.length === 0) {
    console.log('No unchecked client-supplied foreign keys found in server/routes/*.ts');
    process.exit(0);
  }

  console.log(`Found ${allFindings.length} field(s) traced back to req.body with no detected ownership check:\n`);
  for (const f of allFindings) {
    if (f.kind === 'missing-target-company') {
      console.log(`  ${f.file}:${f.line}  [${f.route}]  no req.targetCompanyId reference found in this handler at all`);
    } else {
      console.log(`  ${f.file}:${f.line}  [${f.route}]  '${f.field}: ${f.valueText}' — client-supplied, used in .${f.kind === 'insert' ? 'values' : 'set'}() with no detected ownership check`);
    }
  }
  console.log(`\nThis is a heuristic tripwire, not a formal proof — see .claude/skills/data-isolation-guard/SKILL.md.`);
  console.log(`For each finding: add the appropriate check (assertOwnsRow / branchAccessOk / a dedicated`);
  console.log(`ownership helper), or if it's genuinely already safe in a way this script can't see, say why`);
  console.log(`on a comment line naming the field, e.g.:`);
  console.log(`  // isolation-ok: vendorId inherited from an already company-checked PO above`);
  process.exit(1);
}

main();
