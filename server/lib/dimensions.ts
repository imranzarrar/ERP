// Dynamic dimensions (Finance Core Blueprint FR-DIM, docs/design-notes/gl-step1-5-decisions.md). A company defines as many dimension types as it needs; Branch and
// Department are seeded. Every ledger line carries one deduplicated combination of tags (dimension_combinations), which is what every dimension filter
// reads. This file is the only place that creates combinations, expands hierarchies and applies the account rules, so postings, manual journals and
// reports all agree.
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { generateId } from '../../src/id.js';
import { nowDate } from './clock.js';

export type Tags = Record<string, string>; // dimensionTypeId -> entityId
export type DimRule = 'optional' | 'required' | 'not_allowed';
export interface RuleInfo { rule: DimRule; defaultEntityId: string | null }
export interface DimFilter { typeId: string; entityIds: string[]; isBranch: boolean }

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

// ---------------- seeding ----------------
// Branch and Department exist for every company from day one (Blueprint FR-DIM-01). Idempotent.
export async function seedCompanyDimensions(tx: any, companyId: string): Promise<number> {
  const existing: any[] = await tx.select({ code: schema.dimensionTypes.code }).from(schema.dimensionTypes).where(eq(schema.dimensionTypes.companyId, companyId));
  const have = new Set(existing.map(e => e.code));
  const seeds = [
    { code: 'BRANCH', name: 'Branch', nameAr: 'الفرع', linkedEntity: 'branches', isHierarchical: false, sortOrder: 1 },
    { code: 'DEPARTMENT', name: 'Department / Cost centre', nameAr: 'القسم / مركز التكلفة', linkedEntity: 'cost_centers', isHierarchical: true, sortOrder: 2 },
  ];
  let created = 0;
  for (const s of seeds) {
    if (have.has(s.code)) continue;
    await tx.insert(schema.dimensionTypes).values({ id: generateId(), companyId, code: s.code, name: s.name, nameAr: s.nameAr, valueSource: 'LinkedEntity', linkedEntity: s.linkedEntity, isHierarchical: s.isHierarchical, isSystem: true, sortOrder: s.sortOrder, isActive: true, createdAt: nowDate() });
    created++;
  }
  return created;
}

export async function loadTypes(tx: any, companyId: string): Promise<any[]> {
  const rows: any[] = await tx.select().from(schema.dimensionTypes).where(eq(schema.dimensionTypes.companyId, companyId));
  return rows.sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
}

// ---------------- entities of a type ----------------
// Every selectable entity of a type as { id, code, name, nameAr, parentId, isActive }, whichever table it lives in.
export async function entitiesOfType(tx: any, companyId: string, type: any): Promise<{ id: string; code: string; name: string; nameAr: string | null; parentId: string | null; isActive: boolean }[]> {
  if (type.linkedEntity === 'branches') {
    const rows: any[] = await tx.select().from(schema.branches).where(eq(schema.branches.companyId, companyId));
    return rows.map(b => ({ id: b.id, code: b.code, name: b.name, nameAr: null, parentId: null, isActive: b.isActive !== false }));
  }
  if (type.linkedEntity === 'cost_centers') {
    const rows: any[] = await tx.select().from(schema.costCenters).where(eq(schema.costCenters.companyId, companyId));
    return rows.map(c => ({ id: c.id, code: c.code, name: c.name, nameAr: c.nameAr, parentId: c.parentId, isActive: c.isActive }));
  }
  const rows: any[] = await tx.select().from(schema.dimensionValues).where(and(eq(schema.dimensionValues.companyId, companyId), eq(schema.dimensionValues.dimensionTypeId, type.id)));
  return rows.map(v => ({ id: v.id, code: v.code, name: v.name, nameAr: v.nameAr, parentId: v.parentValueId, isActive: v.isActive }));
}

// The chosen entities plus everything under them (a parent value stands for its children too).
export async function expandWithDescendants(tx: any, companyId: string, type: any, entityIds: string[]): Promise<string[]> {
  if (!type.isHierarchical || entityIds.length === 0) return [...new Set(entityIds)];
  const all = await entitiesOfType(tx, companyId, type);
  const kids = new Map<string, string[]>();
  for (const e of all) if (e.parentId) { const l = kids.get(e.parentId) || []; l.push(e.id); kids.set(e.parentId, l); }
  const out = new Set<string>();
  const walk = (id: string, depth: number) => { if (out.has(id) || depth > 20) return; out.add(id); for (const k of kids.get(id) || []) walk(k, depth + 1); };
  entityIds.forEach(id => walk(id, 0));
  return [...out];
}

// ---------------- combinations ----------------
// Checks every tag (type active, entity of that type, in this company, active) and returns the deduplicated combination id (null for no tags).
export async function resolveCombination(tx: any, companyId: string, tags: Tags, opts: { allowedBranchIds?: string[] | null } = {}): Promise<string | null> {
  const typeIds = Object.keys(tags).filter(t => tags[t]);
  if (typeIds.length === 0) return null;
  const types: any[] = await tx.select().from(schema.dimensionTypes).where(and(eq(schema.dimensionTypes.companyId, companyId), inArray(schema.dimensionTypes.id, typeIds)));
  const byId = new Map<string, any>(types.map(t => [t.id, t]));
  const entries: { typeId: string; entityId: string; valueId: string | null; branchId: string | null; costCenterId: string | null; label: string }[] = [];
  for (const typeId of typeIds) {
    const type = byId.get(typeId);
    if (!type) throw fail(400, 'That dimension does not exist in this company.');
    if (!type.isActive) throw fail(400, `The dimension ${type.name} is inactive.`);
    const entityId = tags[typeId];
    const ent = (await entitiesOfType(tx, companyId, type)).find(e => e.id === entityId);
    if (!ent) throw fail(400, `That ${type.name} value does not exist in this company.`);
    if (!ent.isActive) throw fail(400, `${type.name} ${ent.code} is inactive.`);
    if (type.linkedEntity === 'branches' && Array.isArray(opts.allowedBranchIds) && !opts.allowedBranchIds.includes(entityId)) throw fail(403, 'Forbidden: you are not assigned to that branch.');
    entries.push({ typeId, entityId, valueId: type.valueSource === 'Custom' ? entityId : null, branchId: type.linkedEntity === 'branches' ? entityId : null, costCenterId: type.linkedEntity === 'cost_centers' ? entityId : null, label: ent.name });
  }
  entries.sort((a, b) => a.typeId.localeCompare(b.typeId));
  const dedupKey = createHash('sha1').update(entries.map(e => `${e.typeId}=${e.entityId}`).join('|')).digest('hex');
  const [found] = await tx.select({ id: schema.dimensionCombinations.id }).from(schema.dimensionCombinations).where(and(eq(schema.dimensionCombinations.companyId, companyId), eq(schema.dimensionCombinations.dedupKey, dedupKey)));
  if (found) return found.id;
  const id = generateId();
  const ins: any = await tx.insert(schema.dimensionCombinations).values({ id, companyId, dedupKey, label: entries.map(e => e.label).join(' / '), createdAt: nowDate() }).onConflictDoNothing().returning({ id: schema.dimensionCombinations.id });
  if (!ins.length) { // another request created it between our look and our insert
    const [again] = await tx.select({ id: schema.dimensionCombinations.id }).from(schema.dimensionCombinations).where(and(eq(schema.dimensionCombinations.companyId, companyId), eq(schema.dimensionCombinations.dedupKey, dedupKey)));
    return again.id;
  }
  await tx.insert(schema.dimensionCombinationEntries).values(entries.map(e => ({ id: generateId(), companyId, combinationId: id, dimensionTypeId: e.typeId, entityId: e.entityId, valueId: e.valueId, branchId: e.branchId, costCenterId: e.costCenterId })));
  return id;
}

// combination id -> its tags (typeId -> entityId); for combinations of many lines at once.
export async function tagsOfCombinations(tx: any, companyId: string, ids: string[]): Promise<Map<string, Tags>> {
  const out = new Map<string, Tags>();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return out;
  const rows: any[] = await tx.select().from(schema.dimensionCombinationEntries).where(and(eq(schema.dimensionCombinationEntries.companyId, companyId), inArray(schema.dimensionCombinationEntries.combinationId, uniq)));
  for (const r of rows) { const t = out.get(r.combinationId) || {}; t[r.dimensionTypeId] = r.entityId; out.set(r.combinationId, t); }
  return out;
}

// ---------------- account rules ----------------
export async function loadRules(tx: any, companyId: string, accountIds: string[]): Promise<Map<string, Map<string, RuleInfo>>> {
  const out = new Map<string, Map<string, RuleInfo>>();
  const uniq = [...new Set(accountIds.filter(Boolean))];
  if (!uniq.length) return out;
  const rows: any[] = await tx.select().from(schema.accountDimensionRules).where(and(eq(schema.accountDimensionRules.companyId, companyId), inArray(schema.accountDimensionRules.accountId, uniq)));
  for (const r of rows) {
    const m = out.get(r.accountId) || new Map<string, RuleInfo>();
    m.set(r.dimensionTypeId, { rule: r.rule, defaultEntityId: r.defaultValueId || r.defaultBranchId || r.defaultCostCenterId || null });
    out.set(r.accountId, m);
  }
  return out;
}

// What a line may finally carry. strict (manual journals): a missing Required tag or a Not-allowed tag is an error. defaults (documents, until their forms
// collect dimensions): defaults fill the gaps, Not-allowed tags are dropped, Required is not enforced.
export function applyRules(rules: Map<string, RuleInfo> | undefined, supplied: Tags, mode: 'strict' | 'defaults', names: { type: (id: string) => string }): Tags {
  const out: Tags = { ...supplied };
  for (const [typeId, info] of rules || []) {
    if (info.rule === 'not_allowed') {
      if (out[typeId]) { if (mode === 'strict') throw fail(400, `${names.type(typeId)} is not allowed on this account.`); delete out[typeId]; }
      continue;
    }
    if (!out[typeId] && info.defaultEntityId) out[typeId] = info.defaultEntityId;
    if (!out[typeId] && info.rule === 'required' && mode === 'strict') throw fail(400, `${names.type(typeId)} is required on this account.`);
  }
  return out;
}

// ---------------- report filters ----------------
// Turns a client's filter ({ typeId: [entityIds] }) into verified, hierarchy-expanded filters that resolvedLines understands.
export async function parseDimFilters(tx: any, companyId: string, raw: any): Promise<DimFilter[]> {
  let obj = raw;
  if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch { throw fail(400, 'Invalid dimension filter.'); } }
  if (!obj || typeof obj !== 'object') return [];
  const typeIds = Object.keys(obj).filter(k => Array.isArray(obj[k]) && obj[k].length > 0);
  if (!typeIds.length) return [];
  const types: any[] = await tx.select().from(schema.dimensionTypes).where(and(eq(schema.dimensionTypes.companyId, companyId), inArray(schema.dimensionTypes.id, typeIds)));
  if (types.length !== typeIds.length) throw fail(400, 'Unknown dimension in the filter.');
  const out: DimFilter[] = [];
  for (const t of types) {
    const ids = obj[t.id].map(String);
    const all = await entitiesOfType(tx, companyId, t);
    const known = new Set(all.map(e => e.id));
    if (ids.some((i: string) => !known.has(i))) throw fail(400, `Unknown ${t.name} value in the filter.`);
    out.push({ typeId: t.id, entityIds: await expandWithDescendants(tx, companyId, t, ids), isBranch: t.linkedEntity === 'branches' });
  }
  return out;
}
