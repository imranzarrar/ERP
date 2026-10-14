// The posting profile of a customer, a vendor or a bank account, as edited on its own form: which control account it posts to (customer / vendor) and
// the default dimension tags every ledger line of its documents starts from. The master-data routes call checkProfileInput() so the account and the
// tags are validated in one place; postingContext.ts reads them back when a document posts.
import { and, eq } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { hasPermission } from './authz.js';
import { resolveCombination, tagsOfCombinations, type Tags } from './dimensions.js';

export type ProfileKind = 'customer' | 'vendor' | 'bank';
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

// Takes the profile fields out of a master-data payload (so a client can never write the raw columns) and returns what to store.
// `existing` is the row being edited (undefined on create). Throws {status} errors; the caller turns them into responses.
export async function checkProfileInput(tdb: any, req: any, kind: ProfileKind, data: any, existing: any | undefined): Promise<{ controlAccountId?: string | null; defaultDimensionCombinationId?: string | null }> {
  const rawControl = data.controlAccountId, rawDims = data.defaultDimensions;
  delete data.controlAccountId; delete data.defaultDimensionCombinationId; delete data.defaultDimensions;
  const companyId = req.targetCompanyId;
  const out: { controlAccountId?: string | null; defaultDimensionCombinationId?: string | null } = {};
  if (rawControl === undefined && rawDims === undefined) return out;

  const changes: string[] = [];
  if (rawControl !== undefined && kind !== 'bank') {
    const want: string | null = rawControl ? String(rawControl) : null;
    if (want !== (existing?.controlAccountId || null)) {
      if (want) {
        const [a] = await tdb.select().from(schema.companyAccounts).where(and(eq(schema.companyAccounts.id, want), eq(schema.companyAccounts.companyId, companyId)));
        if (!a) throw fail(400, 'Choose an account of this company.');
        if (a.subledgerType !== kind || a.systemKey || a.isGroup) throw fail(400, `The ${kind === 'customer' ? 'receivable' : 'payable'} account must be a ${kind} control account (Chart of Accounts).`);
        if (!a.isActive) throw fail(400, 'That account is inactive.');
      }
      out.controlAccountId = want; changes.push('account');
    }
  }
  if (rawDims !== undefined) {
    const tags: Tags = {};
    if (rawDims && typeof rawDims === 'object') for (const [k, v] of Object.entries(rawDims)) if (v) tags[k] = String(v);
    const combo = await resolveCombination(tdb, companyId, tags);
    if ((combo || null) !== (existing?.defaultDimensionCombinationId || null)) { out.defaultDimensionCombinationId = combo; changes.push('dimensions'); }
  }
  // Re-pointing where a party's receivable / payable posts, or what it is tagged with, is accounting setup, not customer maintenance.
  if (changes.length && !hasPermission(req.user, 'accountMapping.update')) throw fail(403, 'Changing the control account or default dimensions needs the Account Mapping permission.');
  return out;
}

export async function profileOf(tdb: any, companyId: string, row: { controlAccountId?: string | null; defaultDimensionCombinationId?: string | null } | undefined) {
  const tags = row?.defaultDimensionCombinationId ? (await tagsOfCombinations(tdb, companyId, [row.defaultDimensionCombinationId])).get(row.defaultDimensionCombinationId) || {} : {};
  return { controlAccountId: row?.controlAccountId || null, dimensions: tags };
}
