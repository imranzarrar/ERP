// General Ledger Step 1: the standard Saudi starter chart every company gets, and the helpers that keep it consistent. One place builds accounts
// (seed, bank accounts, import, the Chart of Accounts screen all go through here), so the rules below hold for every path.
import * as schema from '../../src/db/schema.js';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { generateId } from '../../src/id.js';
import { nowDate } from './clock.js';

export type AccountType = 'Asset' | 'Liability' | 'Equity' | 'Revenue' | 'Expense';
export const ACCOUNT_TYPES: AccountType[] = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'];
// Debit-normal types show a positive balance as debit; the others as credit.
export const isDebitNormal = (type: string) => type === 'Asset' || type === 'Expense';

interface ChartSeed { code: string; name: string; nameAr: string; type: AccountType; parent?: string; isGroup?: boolean; systemKey?: string; isControl?: boolean }

export const DEFAULT_CHART: ChartSeed[] = [
  { code: '1000', name: 'Assets', nameAr: 'الأصول', type: 'Asset', isGroup: true },
  { code: '1010', name: 'Cash and Bank (unallocated)', nameAr: 'النقد والبنوك (غير موزعة)', type: 'Asset', parent: '1000', systemKey: 'BANK', isControl: true },
  { code: '1100', name: 'Accounts Receivable', nameAr: 'الذمم المدينة', type: 'Asset', parent: '1000', systemKey: 'AR', isControl: true },
  { code: '1200', name: 'Inventory', nameAr: 'المخزون', type: 'Asset', parent: '1000', systemKey: 'INVENTORY', isControl: true },
  { code: '1300', name: 'VAT Input (Recoverable)', nameAr: 'ضريبة المدخلات القابلة للاسترداد', type: 'Asset', parent: '1000', systemKey: 'VAT_INPUT', isControl: true },
  { code: '1350', name: 'Vendor Credit Receivable', nameAr: 'أرصدة دائنة لدى الموردين', type: 'Asset', parent: '1000', systemKey: 'VENDOR_CREDIT_RECEIVABLE', isControl: true },
  { code: '1400', name: 'Fixed Assets', nameAr: 'الأصول الثابتة', type: 'Asset', parent: '1000', systemKey: 'FIXED_ASSETS' },
  { code: '1450', name: 'Accumulated Depreciation', nameAr: 'مجمع الإهلاك', type: 'Asset', parent: '1000' },
  { code: '2000', name: 'Liabilities', nameAr: 'الالتزامات', type: 'Liability', isGroup: true },
  { code: '2010', name: 'Accounts Payable', nameAr: 'الذمم الدائنة', type: 'Liability', parent: '2000', systemKey: 'AP', isControl: true },
  { code: '2050', name: 'Goods Received Not Invoiced', nameAr: 'بضاعة مستلمة لم تُفوتر', type: 'Liability', parent: '2000', systemKey: 'GR_IR_CLEARING', isControl: true },
  { code: '2100', name: 'VAT Output (Payable)', nameAr: 'ضريبة المخرجات المستحقة', type: 'Liability', parent: '2000', systemKey: 'VAT_OUTPUT', isControl: true },
  { code: '2150', name: 'VAT Payable to Authority', nameAr: 'ضريبة القيمة المضافة المستحقة للهيئة', type: 'Liability', parent: '2000', systemKey: 'VAT_PAYABLE_TO_AUTHORITY', isControl: true },
  { code: '2200', name: 'Accrued Expenses', nameAr: 'مصروفات مستحقة', type: 'Liability', parent: '2000' },
  { code: '2300', name: 'Zakat Payable', nameAr: 'الزكاة المستحقة', type: 'Liability', parent: '2000' },
  { code: '3000', name: 'Equity', nameAr: 'حقوق الملكية', type: 'Equity', isGroup: true },
  { code: '3010', name: 'Owner Capital', nameAr: 'رأس المال', type: 'Equity', parent: '3000', systemKey: 'PAID_IN_CAPITAL' },
  { code: '3100', name: 'Retained Earnings', nameAr: 'الأرباح المبقاة', type: 'Equity', parent: '3000', systemKey: 'RETAINED_EARNINGS' },
  { code: '3200', name: 'Owner Current Account', nameAr: 'الحساب الجاري للمالك', type: 'Equity', parent: '3000' },
  { code: '4000', name: 'Revenue', nameAr: 'الإيرادات', type: 'Revenue', isGroup: true },
  { code: '4010', name: 'Sales Revenue', nameAr: 'إيرادات المبيعات', type: 'Revenue', parent: '4000', systemKey: 'SALES_REVENUE' },
  { code: '4100', name: 'Other Income', nameAr: 'إيرادات أخرى', type: 'Revenue', parent: '4000' },
  { code: '5000', name: 'Cost of Sales', nameAr: 'تكلفة المبيعات', type: 'Expense', isGroup: true },
  { code: '5010', name: 'Cost of Goods Sold', nameAr: 'تكلفة البضاعة المباعة', type: 'Expense', parent: '5000', systemKey: 'COGS' },
  { code: '6000', name: 'Operating Expenses', nameAr: 'المصروفات التشغيلية', type: 'Expense', isGroup: true },
  { code: '6010', name: 'Administrative Expenses', nameAr: 'مصروفات إدارية', type: 'Expense', parent: '6000', systemKey: 'DIRECT_OPEX' },
  { code: '6100', name: 'Staff Salaries and Wages', nameAr: 'رواتب وأجور الموظفين', type: 'Expense', parent: '6000' },
  { code: '6200', name: 'Office Purchases and Supplies', nameAr: 'مشتريات ولوازم مكتبية', type: 'Expense', parent: '6000' },
  { code: '6300', name: 'Repairs and Maintenance', nameAr: 'الإصلاح والصيانة', type: 'Expense', parent: '6000' },
  { code: '6400', name: 'Government Fees', nameAr: 'رسوم حكومية', type: 'Expense', parent: '6000' },
  { code: '6500', name: 'Other Expenses', nameAr: 'مصروفات أخرى', type: 'Expense', parent: '6000' },
  { code: '6700', name: 'Depreciation Expense', nameAr: 'مصروف الإهلاك', type: 'Expense', parent: '6000' },
  { code: '7000', name: 'Other Items', nameAr: 'بنود أخرى', type: 'Expense', isGroup: true },
  { code: '7900', name: 'Rounding Adjustment', nameAr: 'فروقات التقريب', type: 'Expense', parent: '7000', systemKey: 'ROUNDING_ADJUSTMENT' },
];

// The fixed expense categories of the Expense screen and the account each one starts out on.
export const EXPENSE_CATEGORY_DEFAULTS: Record<string, string> = {
  'Admin Expenses': '6010',
  'Staff Salaries': '6100',
  'Office Purchases': '6200',
  'Repair and Maintenance': '6300',
  'Govt Expenses': '6400',
  'Other Expenses': '6500',
};
export const EXPENSE_CATEGORIES = Object.keys(EXPENSE_CATEGORY_DEFAULTS);

// Next free code in a numeric range, e.g. 1020..1099 for bank and cash accounts.
export async function allocateCode(tx: any, companyId: string, from: number, to: number): Promise<string> {
  const rows = await tx.select({ code: schema.companyAccounts.code }).from(schema.companyAccounts).where(eq(schema.companyAccounts.companyId, companyId));
  const used = new Set(rows.map((r: any) => r.code));
  for (let n = from; n <= to; n++) if (!used.has(String(n))) return String(n);
  throw Object.assign(new Error('No free account code left in the range ' + from + '-' + to + '.'), { status: 400 });
}

// Every bank / cash account owns one ledger account (a control account: its movements come from receipts, payments and transfers only).
export async function ensureBankAccount(tx: any, companyId: string, bank: { id: string; bankName: string; accountTitle?: string | null }): Promise<string> {
  const [existing] = await tx.select({ id: schema.companyAccounts.id }).from(schema.companyAccounts)
    .where(and(eq(schema.companyAccounts.companyId, companyId), eq(schema.companyAccounts.bankId, bank.id)));
  if (existing) return existing.id;
  const [parent] = await tx.select({ id: schema.companyAccounts.id }).from(schema.companyAccounts)
    .where(and(eq(schema.companyAccounts.companyId, companyId), eq(schema.companyAccounts.code, '1000')));
  const id = generateId();
  await tx.insert(schema.companyAccounts).values({
    id, companyId, code: await allocateCode(tx, companyId, 1020, 1099), name: bank.bankName, nameAr: null, type: 'Asset',
    parentId: parent?.id || null, isGroup: false, systemKey: null, isControl: true, bankId: bank.id, isActive: true, createdAt: nowDate(),
  });
  return id;
}

// Gives a company the standard chart. Idempotent: safe to run again, never touches an account the company already has by code, never maps a
// system role twice, and never overwrites a name a company changed.
export async function seedCompanyChart(tx: any, companyId: string): Promise<{ created: number; banks: number }> {
  const existing = await tx.select().from(schema.companyAccounts).where(eq(schema.companyAccounts.companyId, companyId));
  const byCode = new Map<string, any>(existing.map((a: any) => [a.code, a]));
  const takenKeys = new Set(existing.map((a: any) => a.systemKey).filter(Boolean));
  let created = 0;
  for (const seed of DEFAULT_CHART) {
    if (byCode.has(seed.code)) continue;
    const parent = seed.parent ? byCode.get(seed.parent) : null;
    const row = {
      id: generateId(), companyId, code: seed.code, name: seed.name, nameAr: seed.nameAr, type: seed.type, parentId: parent?.id || null,
      isGroup: !!seed.isGroup, systemKey: seed.systemKey && !takenKeys.has(seed.systemKey) ? seed.systemKey : null,
      isControl: !!seed.isControl, bankId: null, isActive: true, createdAt: nowDate(),
    };
    if (row.systemKey) takenKeys.add(row.systemKey);
    await tx.insert(schema.companyAccounts).values(row);
    byCode.set(seed.code, row);
    created++;
  }
  const banks = await tx.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
  let bankCount = 0;
  for (const b of banks) {
    const [has] = await tx.select({ id: schema.companyAccounts.id }).from(schema.companyAccounts)
      .where(and(eq(schema.companyAccounts.companyId, companyId), eq(schema.companyAccounts.bankId, b.id)));
    if (!has) { await ensureBankAccount(tx, companyId, b); bankCount++; }
  }
  const mapped = await tx.select({ category: schema.expenseCategoryAccounts.category }).from(schema.expenseCategoryAccounts).where(eq(schema.expenseCategoryAccounts.companyId, companyId));
  const mappedSet = new Set(mapped.map((m: any) => m.category));
  for (const [category, code] of Object.entries(EXPENSE_CATEGORY_DEFAULTS)) {
    if (mappedSet.has(category)) continue;
    const acct = byCode.get(code);
    if (!acct) continue;
    await tx.insert(schema.expenseCategoryAccounts).values({ id: generateId(), companyId, category, accountId: acct.id, updatedAt: nowDate(), updatedById: null });
  }
  return { created, banks: bankCount };
}
