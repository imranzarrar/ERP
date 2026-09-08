import * as schema from '../../src/db/schema.js';
import { generateId } from '../../src/id.js';

// Server-side, atomic equivalent of AdminSettings.tsx's handleAddCompany starter-resource
// bundle (bank account, walk-in customer, cash vendor, MAIN warehouse, standard document
// template, current-month fiscal month) — payload shapes copied verbatim from there.
// handleAddCompany itself is left untouched: it's a separate, already-working, accepted
// non-atomic client-driven flow (6 sequential fetch calls). This helper exists because the
// new company-onboarding-approval flow (server/routes/onboarding.ts) needs real atomicity —
// a request must never end up "half approved" with a company but no warehouse, etc. — which
// only a single db.transaction can guarantee.
export async function provisionStarterResources(tx: any, params: { companyId: string; companyName: string }): Promise<void> {
  const { companyId, companyName } = params;

  await tx.insert(schema.bankAccounts).values({
    id: generateId(),
    bankName: 'Main Operating Bank',
    accountNumber: 'SA' + Math.floor(1000000000000000000000 + Math.random() * 9000000000000000000000).toString(),
    accountTitle: `${companyName} Operating Account`,
    openingBalance: 0,
    isActive: true,
    isDefault: true,
    companyId,
  });

  // B2C: ZATCA only requires a name for these (see server/lib/zatca/validators.ts's
  // validateBuyerFields) — these system placeholder records have no real VAT/address to
  // give, so they must be B2C, not the schema's B2B default.
  await tx.insert(schema.customers).values({
    id: generateId(),
    name: 'Walk-in Customer',
    phone: '-',
    email: '-',
    address: '-',
    isSystem: true,
    buyerType: 'B2C',
    companyId,
  });

  await tx.insert(schema.vendors).values({
    id: generateId(),
    name: 'Cash Vendor',
    phone: '-',
    email: '-',
    address: '-',
    isSystem: true,
    buyerType: 'B2C',
    companyId,
  });

  // Every company owns its own complete, independent set of tax slabs — there is no
  // shared/global default (schema.ts's taxSlabs.companyId comment explains why a shared-
  // rows concept was deliberately removed after it caused real data corruption). Without
  // this, a brand-new company would have ZERO tax slabs at all — every Invoice/Quotation/
  // Expense/POS form's VAT dropdown would be empty until someone manually created one.
  // Standard Saudi VAT (15%) is the only sensible universal default; a company dealing
  // mostly in zero-rated/exempt categories can add those slabs themselves afterward.
  await tx.insert(schema.taxSlabs).values({
    id: generateId(),
    name: 'Standard VAT',
    percentage: 15,
    isDefault: true,
    companyId,
  });

  // Fixed English label by explicit product decision (previously named after the company
  // itself to support Arabic/Urdu company names — that reasoning is intentionally
  // overridden here). isCompanyDefault is always true here — this is unconditionally the
  // company's very first warehouse in this flow (a brand-new company).
  await tx.insert(schema.warehouses).values({
    id: generateId(),
    name: 'Main Warehouse',
    code: 'MAIN',
    isActive: true,
    companyId,
    type: 'sales',
    isCompanyDefault: true,
  });

  await tx.insert(schema.unitsOfMeasure).values({
    id: generateId(),
    name: 'Piece',
    code: 'PCE',
    isActive: true,
    companyId,
  });

  await tx.insert(schema.documentTemplates).values({
    id: generateId(),
    name: 'Standard English (A4)',
    language: 'English',
    pageSize: '8.27in x 11.69in (A4)',
    isActive: true,
    printHeader: true,
    printFooter: true,
    printLogo: true,
    printQrCode: true,
    companyId,
  });

  // The company's starting open month is the real current month at creation time, not a
  // hardcoded date — matches handleAddCompany's own reasoning exactly.
  const now = new Date();
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const currentMonthId = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const currentMonthName = `${monthNames[now.getMonth()]} ${now.getFullYear()}`;
  await tx.insert(schema.fiscalMonths).values({
    id: currentMonthId,
    name: currentMonthName,
    status: 'Open',
    companyId,
  });
}
