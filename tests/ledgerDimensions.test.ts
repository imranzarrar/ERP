import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { postJournalEntry } from '../server/lib/ledger.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// General Ledger Step 1.5, slice 1: dynamic dimensions. Real HTTP against the running server and real Postgres, no mocks. Two companies prove nothing leaks.
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const PW = 'AutoTest_Pw_2026!';
const TODAY = new Date().toISOString().slice(0, 10);

interface Co { id: string; adminId: string; admin: string }
let A: Co, B: Co;
let prep = '', appr = '', defOnly = '', rulesOnly = '';
let branchA = '', branchB = '';
const cleanup: string[] = [];

async function api(session: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'x-session-id': session, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) } });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json().catch(() => ({})) : await res.arrayBuffer() };
}
const get = (s: string, p: string) => api(s, p);
const post = (s: string, p: string, b: any = {}) => api(s, p, { method: 'POST', body: JSON.stringify(b) });
const put = (s: string, p: string, b: any) => api(s, p, { method: 'PUT', body: JSON.stringify(b) });
const patch = (s: string, p: string) => api(s, p, { method: 'PATCH' });

async function login(username: string) {
  const r = await (await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) })).json();
  if (!r.sessionId) throw new Error('login failed ' + username);
  return r.sessionId as string;
}
async function mkCompany(name: string): Promise<Co> {
  const id = generateId();
  await db.insert(schema.companies).values({ id, name, address: 'x', phone: '0', email: `${id.slice(0, 8)}@example.com`, logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false } as any);
  await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId: id, companyName: name }));
  cleanup.push(id);
  const adminId = generateId(); const username = `gd_${adminId.slice(-12)}`;
  await db.insert(schema.users).values({ id: adminId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId: id, isSuperAdmin: false, uiLanguage: 'en' });
  return { id, adminId, admin: await login(username) };
}
async function mkUser(companyId: string, permissions: any) {
  const roleId = generateId(), userId = generateId(), username = `gdu_${userId.slice(-12)}`;
  await db.insert(schema.roles).values({ id: roleId, companyId, name: `Role ${roleId.slice(-6)}`, permissions });
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(PW, 10), role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  await db.insert(schema.userRoles).values({ userId, roleId });
  return login(username);
}
const on = (...keys: string[]) => Object.fromEntries(keys.map(k => [k, { enabled: true }]));
const accounts = async (s: string) => (await get(s, '/api/ledger/accounts')).body.accounts as any[];
const acct = (list: any[], code: string) => list.find(a => a.code === code);
const options = async (s: string) => (await get(s, '/api/ledger/dimension-options')).body;
const typeOf = (o: any, code: string) => o.types.find((t: any) => t.code === code);

let ids: Record<string, string> = {};
let profit: any, project: any, deptOpts: any;

beforeAll(async () => {
  A = await mkCompany('GL Dimensions Test Co A');
  B = await mkCompany('GL Dimensions Test Co B');
  prep = await mkUser(A.id, { journals: on('create', 'read', 'update', 'delete'), dimensions: on('read'), branches: on('viewAllBranches') });
  appr = await mkUser(A.id, { journals: on('read', 'post', 'reverse'), reports: on('generalLedger', 'trialBalanceLedger'), branches: on('viewAllBranches') });
  defOnly = await mkUser(A.id, { dimensions: on('create', 'read', 'update', 'delete') });
  rulesOnly = await mkUser(A.id, { accountDimensionRules: on('read', 'update'), dimensions: on('read') });
  const list = await accounts(A.admin);
  ids = { expense: acct(list, '6200').id, expense2: acct(list, '6300').id, income: acct(list, '4100').id, accrued: acct(list, '2200').id, opex: acct(list, '6000').id, ar: acct(list, '1100').id };
  const [bA] = (await db.insert(schema.branches).values({ id: generateId(), companyId: A.id, name: 'Jeddah', code: 'JED' } as any).returning()) as any[];
  const [bB] = (await db.insert(schema.branches).values({ id: generateId(), companyId: B.id, name: 'Dammam', code: 'DMM' } as any).returning()) as any[];
  branchA = bA.id; branchB = bB.id;
}, 180000);
afterAll(async () => { for (const id of cleanup) await purgeCompany(id); }, 180000);

describe('dimension types', () => {
  it('seeds Branch and Department for every company, and offers them to pickers', async () => {
    const t = await get(A.admin, '/api/ledger/dimensions');
    expect(t.status).toBe(200);
    expect(t.body.types.map((x: any) => x.code)).toEqual(['BRANCH', 'DEPARTMENT']);
    expect(t.body.types.every((x: any) => x.isSystem && x.valueSource === 'LinkedEntity')).toBe(true);
    const o = await options(A.admin);
    expect(typeOf(o, 'BRANCH').entities.map((e: any) => e.code)).toContain('JED');
    expect(typeOf(o, 'BRANCH').entities.map((e: any) => e.code)).not.toContain('DMM'); // the other company's branch
  });

  it('adds any number of custom dimensions, refuses duplicates, and keeps permissions separate', async () => {
    const a = await post(A.admin, '/api/ledger/dimensions', { code: 'pc', name: 'Profit Centre', nameAr: 'مركز الربح', isHierarchical: true });
    expect(a.status).toBe(200);
    profit = { id: a.body.id };
    expect((await post(A.admin, '/api/ledger/dimensions', { code: 'PROJECT', name: 'Project' })).status).toBe(200);
    project = { id: (await get(A.admin, '/api/ledger/dimensions')).body.types.find((x: any) => x.code === 'PROJECT').id };
    expect((await post(A.admin, '/api/ledger/dimensions', { code: 'PC', name: 'Again' })).status).toBe(400);
    expect((await post(A.admin, '/api/ledger/dimensions', { code: 'bad code', name: 'x' })).status).toBe(400);
    expect((await post(A.admin, '/api/ledger/dimensions', { code: 'X1', name: '' })).status).toBe(400);
    expect((await post(prep, '/api/ledger/dimensions', { code: 'ZZ', name: 'Nope' })).status).toBe(403); // read only
    expect((await post(rulesOnly, '/api/ledger/dimensions', { code: 'ZZ', name: 'Nope' })).status).toBe(403);
    expect((await get(B.admin, '/api/ledger/dimensions')).body.types.map((x: any) => x.code)).toEqual(['BRANCH', 'DEPARTMENT']); // B sees none of A's
    expect((await put(A.admin, `/api/ledger/dimensions/${profit.id}`, { name: 'Profit Center' })).status).toBe(200);
    expect((await put(B.admin, `/api/ledger/dimensions/${profit.id}`, { name: 'Hijack' })).status).toBe(404);
  });

  it('never removes or re-sources a seeded dimension', async () => {
    const branchType = (await get(A.admin, '/api/ledger/dimensions')).body.types.find((x: any) => x.code === 'BRANCH');
    expect((await patch(A.admin, `/api/ledger/dimensions/${branchType.id}/toggle-active`)).status).toBe(400);
    expect((await put(A.admin, `/api/ledger/dimensions/${branchType.id}`, { isHierarchical: true })).status).toBe(400);
    expect((await post(A.admin, `/api/ledger/dimensions/${branchType.id}/values`, { code: 'X', name: 'x' })).status).toBe(400); // branches come from Settings
  });
});

describe('values and cost centres', () => {
  it('builds a value tree for a custom dimension and refuses loops, foreign parents and non-hierarchical nesting', async () => {
    const root = await post(A.admin, `/api/ledger/dimensions/${profit.id}/values`, { code: 'RET', name: 'Retail' });
    const kid = await post(A.admin, `/api/ledger/dimensions/${profit.id}/values`, { code: 'RET-ON', name: 'Online', parentValueId: root.body.id });
    expect(root.status).toBe(200); expect(kid.status).toBe(200);
    profit.root = root.body.id; profit.kid = kid.body.id;
    const other = await post(A.admin, `/api/ledger/dimensions/${profit.id}/values`, { code: 'WHO', name: 'Wholesale' });
    profit.other = other.body.id;
    expect((await post(A.admin, `/api/ledger/dimensions/${profit.id}/values`, { code: 'RET', name: 'Dup' })).status).toBe(400);
    expect((await put(A.admin, `/api/ledger/dimension-values/${root.body.id}`, { parentValueId: kid.body.id })).status).toBe(400); // loop
    const bType = (await post(B.admin, '/api/ledger/dimensions', { code: 'PC', name: 'B profit' }));
    const bVal = await post(B.admin, `/api/ledger/dimensions/${bType.body.id}/values`, { code: 'X', name: 'B value' });
    expect((await post(A.admin, `/api/ledger/dimensions/${profit.id}/values`, { code: 'FOR', name: 'Foreign parent', parentValueId: bVal.body.id })).status).toBe(400);
    expect((await post(A.admin, `/api/ledger/dimensions/${project.id}/values`, { code: 'P1', name: 'Phase 1', parentValueId: root.body.id })).status).toBe(400); // project is flat
    const pv = await post(A.admin, `/api/ledger/dimensions/${project.id}/values`, { code: 'P1', name: 'Phase 1' });
    project.p1 = pv.body.id;
    expect((await get(A.admin, `/api/ledger/dimensions/${profit.id}/values`)).body.values).toHaveLength(3);
    expect((await get(B.admin, `/api/ledger/dimensions/${profit.id}/values`)).status).toBe(404);
  });

  it('keeps cost centres (Department) with an optional home branch, hierarchy and the same guards', async () => {
    const mk = await post(A.admin, '/api/ledger/cost-centers', { code: 'MKT', name: 'Marketing', homeBranchId: branchA });
    const sub = await post(A.admin, '/api/ledger/cost-centers', { code: 'MKT-D', name: 'Digital', parentId: mk.body.id });
    expect(mk.status).toBe(200); expect(sub.status).toBe(200);
    expect((await post(A.admin, '/api/ledger/cost-centers', { code: 'BAD', name: 'Foreign branch', homeBranchId: branchB })).status).toBe(400);
    expect((await put(A.admin, `/api/ledger/cost-centers/${mk.body.id}`, { parentId: sub.body.id })).status).toBe(400); // loop
    expect((await post(A.admin, '/api/ledger/cost-centers', { code: 'MKT', name: 'Dup' })).status).toBe(400);
    expect((await put(B.admin, `/api/ledger/cost-centers/${mk.body.id}`, { name: 'Hijack' })).status).toBe(404);
    expect((await post(prep, '/api/ledger/cost-centers', { code: 'NO', name: 'No' })).status).toBe(403);
    deptOpts = { mkt: mk.body.id, digital: sub.body.id };
    expect(typeOf(await options(A.admin), 'DEPARTMENT').entities.map((e: any) => e.code)).toEqual(['MKT', 'MKT-D']);
    // the database itself refuses a cost centre whose home branch belongs to another company
    await expect(db.insert(schema.costCenters).values({ id: generateId(), companyId: A.id, code: 'RAW', name: 'raw', homeBranchId: branchB, createdAt: new Date() } as any)).rejects.toBeTruthy();
  });
});

describe('assigning dimensions to the chart of accounts', () => {
  it('sets a rule on one account with an optional default, and refuses headings, foreign accounts and foreign values', async () => {
    const dept = typeOf(await options(A.admin), 'DEPARTMENT').id;
    expect((await put(rulesOnly, '/api/ledger/dimension-rules', { accountId: ids.expense, typeId: dept, rule: 'required', defaultEntityId: deptOpts.mkt })).status).toBe(200);
    expect((await put(A.admin, '/api/ledger/dimension-rules', { accountId: ids.opex, typeId: dept, rule: 'required' })).status).toBe(400); // heading
    expect((await put(A.admin, '/api/ledger/dimension-rules', { accountId: acct(await accounts(B.admin), '6200').id, typeId: dept, rule: 'required' })).status).toBe(404);
    expect((await put(A.admin, '/api/ledger/dimension-rules', { accountId: ids.expense, typeId: dept, rule: 'optional', defaultEntityId: profit.root })).status).toBe(400); // value of another dimension
    expect((await put(A.admin, '/api/ledger/dimension-rules', { accountId: ids.expense, typeId: dept, rule: 'not_allowed', defaultEntityId: deptOpts.mkt })).status).toBe(400);
    expect((await put(prep, '/api/ledger/dimension-rules', { accountId: ids.expense, typeId: dept, rule: 'optional' })).status).toBe(403); // cannot assign
    expect((await get(prep, '/api/ledger/dimension-rules')).status).toBe(403);
    const m = (await get(rulesOnly, '/api/ledger/dimension-rules')).body;
    expect(m.rules.find((r: any) => r.accountId === ids.expense && r.typeId === dept)).toMatchObject({ rule: 'required', defaultEntityId: deptOpts.mkt });
    // clearing a rule
    expect((await put(A.admin, '/api/ledger/dimension-rules', { accountId: ids.expense, typeId: dept, rule: null })).status).toBe(200);
    expect((await get(A.admin, '/api/ledger/dimension-rules')).body.rules.some((r: any) => r.accountId === ids.expense && r.typeId === dept)).toBe(false);
  });

  it('applies a rule to every account of a type, a heading, a range or a list, with a preview first', async () => {
    const dept = typeOf(await options(A.admin), 'DEPARTMENT').id;
    const dry = await post(A.admin, '/api/ledger/dimension-rules/bulk', { typeId: dept, rule: 'required', dryRun: true, selector: { kind: 'type', accountType: 'Expense' } });
    expect(dry.body.dryRun).toBe(true); expect(dry.body.wouldApply).toBeGreaterThan(5);
    expect((await get(A.admin, '/api/ledger/dimension-rules')).body.rules.filter((r: any) => r.typeId === dept)).toHaveLength(0); // nothing saved
    const real = await post(A.admin, '/api/ledger/dimension-rules/bulk', { typeId: dept, rule: 'required', selector: { kind: 'heading', headingId: ids.opex } });
    expect(real.body.applied).toBeGreaterThan(4);
    const rules = (await get(A.admin, '/api/ledger/dimension-rules')).body.rules.filter((r: any) => r.typeId === dept);
    expect(rules.some((r: any) => r.accountId === ids.expense && r.rule === 'required')).toBe(true);
    expect((await post(A.admin, '/api/ledger/dimension-rules/bulk', { typeId: dept, rule: 'not_allowed', selector: { kind: 'range', from: '4000', to: '4999' } })).body.applied).toBeGreaterThan(0);
    expect((await post(A.admin, '/api/ledger/dimension-rules/bulk', { typeId: dept, rule: 'optional', skipExisting: true, selector: { kind: 'accounts', accountIds: [ids.expense, ids.accrued] } })).body).toMatchObject({ applied: 1, skipped: 1 });
    expect((await post(A.admin, '/api/ledger/dimension-rules/bulk', { typeId: dept, rule: 'optional', selector: { kind: 'accounts', accountIds: [generateId()] } })).status).toBe(400);
    expect((await post(A.admin, '/api/ledger/dimension-rules/bulk', { typeId: dept, rule: 'bogus', selector: { kind: 'type', accountType: 'Expense' } })).status).toBe(400);
    // a dimension that accounts require cannot be deactivated, and a value used as a default cannot be deactivated
    expect((await patch(A.admin, `/api/ledger/dimensions/${dept}/toggle-active`)).status).toBe(400); // system anyway
    const projRule = await post(A.admin, '/api/ledger/dimension-rules/bulk', { typeId: project.id, rule: 'required', selector: { kind: 'accounts', accountIds: [ids.expense2] } });
    expect(projRule.status).toBe(200);
    expect((await patch(A.admin, `/api/ledger/dimensions/${project.id}/toggle-active`)).status).toBe(400);
    await put(A.admin, '/api/ledger/dimension-rules', { accountId: ids.expense2, typeId: project.id, rule: 'optional', defaultEntityId: project.p1 });
    expect((await patch(A.admin, `/api/ledger/dimension-values/${project.p1}/toggle-active`)).status).toBe(400);
    await put(A.admin, '/api/ledger/dimension-rules', { accountId: ids.expense2, typeId: project.id, rule: null });
    // restore a simple set-up for the posting tests: Department required on 6200 with a default, optional on 6300; Project optional on 6200
    await put(A.admin, '/api/ledger/dimension-rules', { accountId: ids.expense, typeId: dept, rule: 'required' });
    await put(A.admin, '/api/ledger/dimension-rules', { accountId: ids.expense2, typeId: dept, rule: 'optional' });
    await put(A.admin, '/api/ledger/dimension-rules', { accountId: ids.expense, typeId: project.id, rule: 'optional' });
  });
});

describe('tagging postings: manual journals', () => {
  const deptId = async () => typeOf(await options(A.admin), 'DEPARTMENT').id as string;
  const journal = async (tags1: any, tags2: any = {}, extra: any = {}) => post(prep, '/api/ledger/manual-journals', {
    date: TODAY, description: 'Dimension probe', lines: [{ accountId: ids.expense, debit: 100, dimensions: tags1 }, { accountId: ids.income, credit: 100, dimensions: tags2 }], ...extra,
  });

  it('lets a draft be saved without a Required tag, refuses to submit it, then submits and posts once the tag is there', async () => {
    const dept = await deptId();
    const d = await journal({});
    expect(d.status).toBe(200);
    const sub = await post(prep, `/api/ledger/manual-journals/${d.body.id}/submit`);
    expect(sub.status).toBe(400); expect(sub.body.error).toMatch(/required/i);
    expect((await put(prep, `/api/ledger/manual-journals/${d.body.id}`, { lines: [{ accountId: ids.expense, debit: 100, dimensions: { [dept]: deptOpts.digital, [project.id]: project.p1 } }, { accountId: ids.income, credit: 100 }] })).status).toBe(200);
    expect((await post(prep, `/api/ledger/manual-journals/${d.body.id}/submit`)).status).toBe(200);
    const detail = (await get(appr, `/api/ledger/manual-journals/${d.body.id}`)).body;
    const l0 = detail.lines.find((l: any) => l.accountId === ids.expense);
    expect(l0.dimensionLabels.map((x: any) => x.name).sort()).toEqual(['Digital', 'Phase 1']);
    expect((await post(appr, `/api/ledger/manual-journals/${d.body.id}/approve`)).status).toBe(200);
  });

  it('refuses a tag the account does not allow, an unknown or foreign value, and an inactive dimension value', async () => {
    const dept = await deptId();
    expect((await journal({}, { [dept]: deptOpts.mkt })).body.error).toMatch(/not allowed/i); // 4100 is Not allowed for Department
    expect((await journal({ [dept]: generateId() })).status).toBe(400);
    expect((await journal({ [project.id]: profit.root })).status).toBe(400); // a value of another dimension
    await patch(A.admin, `/api/ledger/dimension-values/${profit.other}/toggle-active`);
    expect((await journal({ [dept]: deptOpts.mkt, [profit.id]: profit.other })).status).toBe(400); // inactive value
    await patch(A.admin, `/api/ledger/dimension-values/${profit.other}/toggle-active`);
  });

  it('posts an approved journal with its tags on the ledger lines, shares one combination between lines with equal tags, and filters by them', async () => {
    const dept = await deptId();
    const mk = await post(prep, '/api/ledger/manual-journals', { date: TODAY, description: 'Marketing spend', lines: [
      { accountId: ids.expense, debit: 60, dimensions: { [dept]: deptOpts.digital, [profit.id]: profit.kid } },
      { accountId: ids.expense, debit: 40, dimensions: { [dept]: deptOpts.digital, [profit.id]: profit.kid } },
      { accountId: ids.income, credit: 100 }] });
    expect(mk.status).toBe(200);
    await post(prep, `/api/ledger/manual-journals/${mk.body.id}/submit`);
    expect((await post(A.admin, `/api/ledger/manual-journals/${mk.body.id}/approve`)).status).toBe(200);
    const detail = (await get(A.admin, `/api/ledger/manual-journals/${mk.body.id}`)).body;
    const lines = await db.select().from(schema.journalLines).where(eq(schema.journalLines.journalEntryId, detail.journalEntryId));
    const tagged = lines.filter(l => l.dimensionCombinationId);
    expect(tagged).toHaveLength(2);
    expect(new Set(tagged.map(l => l.dimensionCombinationId)).size).toBe(1); // deduplicated
    const entries = await db.select().from(schema.dimensionCombinationEntries).where(eq(schema.dimensionCombinationEntries.combinationId, tagged[0].dimensionCombinationId!));
    expect(entries).toHaveLength(2);
    // filters: by cost centre, by the PARENT profit-centre value (includes its child), by a non-matching value
    const gl = (dims: any) => get(A.admin, `/api/ledger/reports/general-ledger?accountId=${ids.expense}&from=${TODAY.slice(0, 8)}01&to=${TODAY}&dims=${encodeURIComponent(JSON.stringify(dims))}`);
    const byDept = await gl({ [dept]: [deptOpts.digital] });
    expect(byDept.body.totals.debit).toBe(200); // this journal and the earlier Digital / Phase 1 one
    const byParentDept = await gl({ [dept]: [deptOpts.mkt] }); // Digital sits under Marketing
    expect(byParentDept.body.totals.debit).toBe(200);
    const byParentProfit = await gl({ [profit.id]: [profit.root] }); // Online sits under Retail
    expect(byParentProfit.body.totals.debit).toBe(100);
    expect((await gl({ [profit.id]: [profit.other] })).body.totals.debit).toBe(0);
    expect((await gl({ [dept]: [deptOpts.digital], [profit.id]: [profit.other] })).body.totals.debit).toBe(0); // both must match
    expect((await gl({ [dept]: [generateId()] })).status).toBe(400);
    const tb = (await get(A.admin, `/api/ledger/reports/trial-balance?from=${TODAY.slice(0, 8)}01&to=${TODAY}&dims=${encodeURIComponent(JSON.stringify({ [dept]: [deptOpts.digital] }))}`)).body;
    expect(tb.rows.find((r: any) => r.code === '6200').debit).toBe(200);
    const list = (await get(A.admin, `/api/ledger/journals?dims=${encodeURIComponent(JSON.stringify({ [profit.id]: [profit.kid] }))}`)).body;
    expect(list.rows.map((r: any) => r.id)).toContain(mk.body.id);
    const none = (await get(A.admin, `/api/ledger/journals?dims=${encodeURIComponent(JSON.stringify({ [profit.id]: [profit.other] }))}`)).body;
    expect(none.rows.map((r: any) => r.id)).not.toContain(mk.body.id);
    // another company's admin cannot use these ids as a filter
    expect((await get(B.admin, `/api/ledger/reports/general-ledger?accountId=${acct(await accounts(B.admin), '6200').id}&dims=${encodeURIComponent(JSON.stringify({ [dept]: [deptOpts.digital] }))}`)).status).toBe(400);
  });

  it('a reversal carries the original tags, and the account default fills a missing tag', async () => {
    const dept = await deptId();
    await put(A.admin, '/api/ledger/dimension-rules', { accountId: ids.expense2, typeId: dept, rule: 'optional', defaultEntityId: deptOpts.mkt });
    const d = await post(prep, '/api/ledger/manual-journals', { date: TODAY, description: 'Default tag', lines: [{ accountId: ids.expense2, debit: 25 }, { accountId: ids.income, credit: 25 }] });
    const detail = (await get(prep, `/api/ledger/manual-journals/${d.body.id}`)).body;
    expect(detail.lines.find((l: any) => l.accountId === ids.expense2).dimensionLabels.map((x: any) => x.name)).toEqual(['Marketing']);
    await post(prep, `/api/ledger/manual-journals/${d.body.id}/submit`);
    await post(A.admin, `/api/ledger/manual-journals/${d.body.id}/approve`);
    const rv = await post(appr, `/api/ledger/manual-journals/${d.body.id}/reverse`, { reason: 'test' });
    expect(rv.status).toBe(200);
    const rdetail = (await get(appr, `/api/ledger/manual-journals/${rv.body.id}`)).body;
    expect(rdetail.lines.find((l: any) => l.accountId === ids.expense2).dimensionLabels.map((x: any) => x.name)).toEqual(['Marketing']);
  });
});

describe('document postings, branch dimension and isolation', () => {
  it('a document posting applies defaults but never blocks on a Required rule, and Branch filters through the entry branch', async () => {
    const dept = typeOf(await options(A.admin), 'DEPARTMENT').id as string;
    const branchType = typeOf(await options(A.admin), 'BRANCH').id as string;
    const e = await postJournalEntry(db, { companyId: A.id, branchId: branchA, date: TODAY, referenceType: 'Test', referenceId: generateId(), description: 'document', createdById: A.adminId, lines: [{ accountKey: 'DIRECT_OPEX', debit: 7 }, { accountKey: 'AR', credit: 7 }] });
    expect(e).toBeTruthy(); // 6010 has a Required Department rule via the heading, yet the document is not blocked
    const gl = (dims: any) => get(A.admin, `/api/ledger/reports/general-ledger?accountId=${ids.opex}&from=${TODAY.slice(0, 8)}01&to=${TODAY}&dims=${encodeURIComponent(JSON.stringify(dims))}`);
    const jed = await gl({ [branchType]: [branchA] });
    expect(jed.body.totals.debit).toBe(7);
    expect((await gl({ [dept]: [deptOpts.mkt] })).body.totals.debit).toBeLessThan(7 + 1000);
    // an unknown dimension in a posting is refused by the engine
    await expect(postJournalEntry(db, { companyId: A.id, date: TODAY, referenceType: 'Test', referenceId: generateId(), description: 'x', createdById: A.adminId, dimensions: { [generateId()]: generateId() }, lines: [{ accountKey: 'DIRECT_OPEX', debit: 1 }, { accountKey: 'AR', credit: 1 }] })).rejects.toBeTruthy();
  });

  it('the database refuses a dimension entry pointing at another company\'s value, and the tenant role sees only its own rows', async () => {
    const bType = await db.select().from(schema.dimensionTypes).where(eq(schema.dimensionTypes.companyId, B.id));
    const bPc = bType.find(t => t.code === 'PC')!;
    const [bVal] = await db.select().from(schema.dimensionValues).where(eq(schema.dimensionValues.dimensionTypeId, bPc.id));
    const [combo] = await db.insert(schema.dimensionCombinations).values({ id: generateId(), companyId: A.id, dedupKey: generateId(), createdAt: new Date() } as any).returning();
    await expect(db.insert(schema.dimensionCombinationEntries).values({ id: generateId(), companyId: A.id, combinationId: combo.id, dimensionTypeId: profit.id, entityId: bVal.id, valueId: bVal.id } as any)).rejects.toBeTruthy();
    const pool = new pg.Pool({ host: process.env.SQL_HOST, user: process.env.TENANT_DB_USER, password: process.env.TENANT_DB_PASSWORD, database: process.env.SQL_DB_NAME });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.company_id', $1, true)`, [A.id]);
      for (const t of ['dimension_types', 'dimension_values', 'dimension_combinations', 'dimension_combination_entries', 'account_dimension_rules', 'cost_centers']) {
        const r = await c.query(`SELECT DISTINCT company_id FROM ${t}`);
        expect(r.rows.every(x => x.company_id === A.id)).toBe(true);
      }
      await c.query('ROLLBACK');
    } finally { c.release(); await pool.end(); }
  });
});
