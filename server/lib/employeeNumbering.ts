import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { reserveNextCounterValue } from './documentNumbering.js';

// Employee numbers share the exact same atomic per-company counter mechanism as document
// numbering (documentCounters, via reserveNextCounterValue) — a separate 'employee' docType
// row, permanently keyed to periodKey 'NONE' since an employee number must never reset
// by year/month the way an invoice number can. Unlike a document number, this applies NO
// prefix or separator: just the zero-padded digits, so "number only" holds by
// construction — nothing here is ever free-typed by a user.
const EMPLOYEE_DOC_TYPE = 'employee';
const EMPLOYEE_PERIOD_KEY = 'NONE';

export interface HrSettings {
  employeeNumberPadWidth?: number; // 4 or 5; defaults to 4
  employeeNumberStart?: number; // only matters the first time this company's counter is created; defaults to 1
}

// Must be called with the transaction executor of an enclosing db.transaction(...) block,
// same requirement as getAndIncrementDocumentNumber. Returns the new employee's
// zero-padded, digits-only employee number (e.g. "0042").
export async function getAndIncrementEmployeeNumber(tx: any, companyId: string): Promise<string> {
  const [company] = await tx.select({ hrSettings: schema.companies.hrSettings }).from(schema.companies).where(eq(schema.companies.id, companyId));
  if (!company) throw new Error('Company not found');

  const hrSettings = (company.hrSettings as HrSettings) || {};
  const padWidth = hrSettings.employeeNumberPadWidth === 5 ? 5 : 4;
  // reserveNextCounterValue's own seed convention is "first issued = seed + 1" — so a
  // configured start of, say, 1048 (continuing an existing HRIS sequence) must seed with
  // 1047, and the default start of 1 seeds with 0 (first employee becomes "0001").
  const seedValue = (typeof hrSettings.employeeNumberStart === 'number' && hrSettings.employeeNumberStart > 0)
    ? hrSettings.employeeNumberStart - 1
    : 0;

  const newValue = await reserveNextCounterValue(tx, companyId, EMPLOYEE_DOC_TYPE, EMPLOYEE_PERIOD_KEY, seedValue);
  return String(newValue).padStart(padWidth, '0');
}

// Read-only, display-purposes-only preview of "what would the next employee number look
// like right now" — never increments anything. Mirrors documentNumbering.ts's own
// previewNextDocumentNumbers/hashChain.ts's documented unlocked/display-only pattern.
export async function previewNextEmployeeNumber(companyId: string): Promise<string> {
  const [company] = await db.select({ hrSettings: schema.companies.hrSettings }).from(schema.companies).where(eq(schema.companies.id, companyId));
  if (!company) throw new Error('Company not found');

  const hrSettings = (company.hrSettings as HrSettings) || {};
  const padWidth = hrSettings.employeeNumberPadWidth === 5 ? 5 : 4;
  const seedValue = (typeof hrSettings.employeeNumberStart === 'number' && hrSettings.employeeNumberStart > 0)
    ? hrSettings.employeeNumberStart - 1
    : 0;

  const [counter] = await db.select({ currentValue: schema.documentCounters.currentValue }).from(schema.documentCounters)
    .where(and(
      eq(schema.documentCounters.companyId, companyId),
      eq(schema.documentCounters.docType, EMPLOYEE_DOC_TYPE),
      eq(schema.documentCounters.periodKey, EMPLOYEE_PERIOD_KEY),
    ));
  const current = counter?.currentValue ?? seedValue;
  return String(current + 1).padStart(padWidth, '0');
}
