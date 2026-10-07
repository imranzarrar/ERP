import { describe, it, expect } from 'vitest';
import { checkRecurringPreconditions } from '../src/dbStore.js';

// A month can only be closed once every active recurring template has been posted (as Actual or Accrual) for it. The check must find a
// posting by its template and month: the server saves each posting under an opaque generated id (never `${templateId}_${monthId}`), and
// matching on that composed key meant a posted template still read as unposted, so a month with recurring templates could never be closed.
const mk = (postings: any[], templates: any[] = [{ id: 'T1', isActive: true, companyId: 'C1', description: 'Rent' }, { id: 'T2', isActive: true, companyId: 'C1', description: 'Utilities' }]) =>
  ({ selectedCompanyId: 'C1', recurringTemplates: templates, recurringPostings: postings }) as any;

describe('checkRecurringPreconditions', () => {
  it('is satisfied when every active template has a posting for the month, whatever the posting id looks like', () => {
    const r = checkRecurringPreconditions(mk([
      { id: '01a115da-3a10-7af7-b974-55f13bbc61ec', templateId: 'T1', monthId: '2026-09', status: 'Posted as Accrual', expenseId: 'E1' },
      { id: '01a115da-4b21-7000-b974-000000000001', templateId: 'T2', monthId: '2026-09', status: 'Posted as Actual', expenseId: 'E2' },
    ]), '2026-09', 'C1');
    expect(r.satisfied).toBe(true);
    expect(r.unposted).toEqual([]);
  });

  it('lists the templates still unposted for that month only', () => {
    const r = checkRecurringPreconditions(mk([
      { id: 'x1', templateId: 'T1', monthId: '2026-08', status: 'Posted as Actual', expenseId: 'E0' },   // another month: does not count
      { id: 'x2', templateId: 'T2', monthId: '2026-09', status: 'Posted as Actual', expenseId: 'E2' },
    ]), '2026-09', 'C1');
    expect(r.satisfied).toBe(false);
    expect(r.unposted.map((t: any) => t.description)).toEqual(['Rent']);
  });

  it('treats an explicit Unposted row as unposted, and ignores inactive templates', () => {
    const r = checkRecurringPreconditions(mk(
      [{ id: 'x1', templateId: 'T1', monthId: '2026-09', status: 'Unposted', expenseId: null }],
      [{ id: 'T1', isActive: true, companyId: 'C1', description: 'Rent' }, { id: 'T3', isActive: false, companyId: 'C1', description: 'Old' }],
    ), '2026-09', 'C1');
    expect(r.unposted.map((t: any) => t.description)).toEqual(['Rent']);
  });
});
