import React from 'react';
import { useTranslation, usePermissions } from '../hooks';
import { DatabaseState, generateId } from '../dbStore';
import { JobTitle, Employee } from '../types';
import { Plus, Briefcase, IdCard, Trash, Check } from 'lucide-react';

interface EmployeesModuleProps {
  db: DatabaseState;
  onUpdateDbLocal: (updater: (prev: DatabaseState) => DatabaseState) => void;
  onRefreshDb?: () => Promise<void>;
  currentUser: any;
  defaultTab?: 'employees' | 'employees-add' | 'job-titles' | 'job-titles-add';
}

// Displayed everywhere an employee is picked or listed — number first, since names can
// collide across a company's roster and the number is the actual unique identifier.
function employeeLabel(e: Employee) {
  return `${e.employeeNumber} — ${e.name}`;
}

export default function EmployeesModule({ db, onUpdateDbLocal, onRefreshDb, currentUser, defaultTab = 'employees' }: EmployeesModuleProps) {
  const { t } = useTranslation(db);
  const { can } = usePermissions(currentUser);
  const companyId = db.selectedCompanyId;

  const activeSubTab: 'employees' | 'job-titles' = defaultTab.startsWith('job-titles') ? 'job-titles' : 'employees';
  const startInAddMode = defaultTab === 'employees-add' || defaultTab === 'job-titles-add';

  const jobTitles = (db.jobTitles || []).filter(jt => jt.companyId === companyId);
  const employees = (db.employees || []).filter(e => e.companyId === companyId);
  const branches = (db.branches || []).filter(b => b.companyId === companyId && b.isActive !== false);

  const [success, setSuccess] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const triggerSuccess = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(null), 3500); };
  const triggerError = (msg: string) => { setError(msg); setTimeout(() => setError(null), 4500); };

  // --- Job Titles ---
  const [jtTitle, setJtTitle] = React.useState('');
  const [jtDescription, setJtDescription] = React.useState('');
  const [jtIsSalesRole, setJtIsSalesRole] = React.useState(false);
  const [editingJobTitleId, setEditingJobTitleId] = React.useState<string | null>(null);
  const canCreateJobTitles = can('jobTitles.create');
  const canUpdateJobTitles = can('jobTitles.update');
  const canDeleteJobTitles = can('jobTitles.delete');

  const clearJobTitleForm = () => {
    setEditingJobTitleId(null);
    setJtTitle('');
    setJtDescription('');
    setJtIsSalesRole(false);
  };

  const startEditJobTitle = (jt: JobTitle) => {
    setEditingJobTitleId(jt.id);
    setJtTitle(jt.title);
    setJtDescription(jt.description || '');
    setJtIsSalesRole(!!jt.isSalesRole);
  };

  const handleSaveJobTitle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!jtTitle.trim()) return triggerError(t('A job title is required.'));
    try {
      const res = await fetch('/api/job-titles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingJobTitleId || undefined,
          title: jtTitle.trim(),
          description: jtDescription.trim() || null,
          isSalesRole: jtIsSalesRole,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) return triggerError(data.error || t('Failed to save job title.'));
      triggerSuccess(editingJobTitleId ? t('Job title updated successfully.') : t('Job title added successfully.'));
      clearJobTitleForm();
      if (onRefreshDb) await onRefreshDb();
    } catch {
      triggerError(t('Failed to save job title.'));
    }
  };

  const handleToggleJobTitleActive = async (id: string) => {
    const jt = jobTitles.find(x => x.id === id);
    const isActive = jt?.isActive !== false;
    if (isActive && !window.confirm(t('Deactivate this job title? Existing employees keep it, but it will no longer be selectable for new employees.'))) return;
    try {
      const res = await fetch(`/api/job-titles/${id}/toggle-active`, { method: 'PATCH' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) return triggerError(data.error || t('Failed to update job title status.'));
      triggerSuccess(isActive ? t('Job title deactivated.') : t('Job title reactivated.'));
      if (onRefreshDb) await onRefreshDb();
    } catch {
      triggerError(t('Failed to update job title status.'));
    }
  };

  // --- Employees ---
  const [empName, setEmpName] = React.useState('');
  const [empJobTitleId, setEmpJobTitleId] = React.useState('');
  const [empBranchId, setEmpBranchId] = React.useState(''); // '' = Head Office (company-wide)
  const [empEmail, setEmpEmail] = React.useState('');
  const [empPhone, setEmpPhone] = React.useState('');
  const [empHireDate, setEmpHireDate] = React.useState('');
  const [editingEmployeeId, setEditingEmployeeId] = React.useState<string | null>(null);
  const canCreateEmployees = can('employees.create');
  const canUpdateEmployees = can('employees.update');
  const canDeleteEmployees = can('employees.delete');

  const clearEmployeeForm = () => {
    setEditingEmployeeId(null);
    setEmpName('');
    setEmpJobTitleId('');
    setEmpBranchId('');
    setEmpEmail('');
    setEmpPhone('');
    setEmpHireDate('');
  };

  const startEditEmployee = (emp: Employee) => {
    setEditingEmployeeId(emp.id);
    setEmpName(emp.name);
    setEmpJobTitleId(emp.jobTitleId);
    setEmpBranchId(emp.branchId || '');
    setEmpEmail(emp.email || '');
    setEmpPhone(emp.phone || '');
    setEmpHireDate(emp.hireDate || '');
  };

  const handleSaveEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!empName.trim()) return triggerError(t('Employee name is required.'));
    if (!empJobTitleId) return triggerError(t('A job title is required.'));
    try {
      const res = await fetch('/api/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingEmployeeId || undefined,
          name: empName.trim(),
          jobTitleId: empJobTitleId,
          branchId: empBranchId || null,
          email: empEmail.trim() || null,
          phone: empPhone.trim() || null,
          hireDate: empHireDate || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) return triggerError(data.error || t('Failed to save employee.'));
      triggerSuccess(editingEmployeeId
        ? t('Employee updated successfully.')
        : `${t('Employee onboarded successfully — Employee Number')} ${data.employeeNumber}`);
      clearEmployeeForm();
      if (onRefreshDb) await onRefreshDb();
    } catch {
      triggerError(t('Failed to save employee.'));
    }
  };

  const handleToggleEmployeeActive = async (id: string) => {
    const emp = employees.find(x => x.id === id);
    const isActive = emp?.isActive !== false;
    if (isActive && !window.confirm(t('Deactivate (terminate) this employee? Their record and history stay intact, and any linked ERP login is not affected — that is a separate action. You can reactivate them anytime.'))) return;
    try {
      const res = await fetch(`/api/employees/${id}/toggle-active`, { method: 'PATCH' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) return triggerError(data.error || t('Failed to update employee status.'));
      triggerSuccess(isActive ? t('Employee deactivated.') : t('Employee reactivated.'));
      if (onRefreshDb) await onRefreshDb();
    } catch {
      triggerError(t('Failed to update employee status.'));
    }
  };

  const jobTitleName = (id: string) => jobTitles.find(jt => jt.id === id)?.title || t('Unknown');
  const branchName = (id?: string | null) => id ? (branches.find(b => b.id === id)?.name || t('Unknown Branch')) : t('Head Office (Company-wide)');

  return (
    <div className="p-6 space-y-6">
      {success && <div className="p-3 bg-emerald-50 text-emerald-700 rounded-xl border border-emerald-100 text-xs font-semibold">{success}</div>}
      {error && <div className="p-3 bg-rose-50 text-rose-700 rounded-xl border border-rose-100 text-xs font-semibold">{error}</div>}

      <div>
        <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2"><Briefcase className="w-4 h-4" /> {t('Human Resources')}</h3>
        <p className="text-[11px] text-slate-400">{t('Employee onboarding and job titles — the foundation this ERP uses to attribute sales, and later Timekeeping/Attendance, to real staff.')}</p>
      </div>

      {activeSubTab === 'job-titles' ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 border border-slate-100 rounded-2xl overflow-hidden shadow-sm">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 text-slate-500">
                  <th className="p-3 text-start">{t('Title')}</th>
                  <th className="p-3 text-center">{t('Sales Role')}</th>
                  <th className="p-3 text-center">{t('Status')}</th>
                  <th className="p-3 text-end">{t('Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {jobTitles.length === 0 ? (
                  <tr><td colSpan={4} className="p-6 text-center text-slate-400">{t('No job titles yet.')}</td></tr>
                ) : jobTitles.map(jt => (
                  <tr key={jt.id} className={`border-b border-slate-100 last:border-0 ${jt.isActive === false ? 'opacity-50' : ''}`}>
                    <td className="p-3">
                      <div className="font-semibold text-slate-800">{jt.title}</div>
                      {jt.description && <div className="text-[10px] text-slate-400 font-normal mt-0.5">{jt.description}</div>}
                    </td>
                    <td className="p-3 text-center">
                      {jt.isSalesRole
                        ? <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-indigo-50 text-indigo-700 border border-indigo-200">{t('Yes')}</span>
                        : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="p-3 text-center">
                      {jt.isActive === false
                        ? <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-slate-100 text-slate-500 border border-slate-200">{t('Inactive')}</span>
                        : <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-emerald-50 text-emerald-700 border border-emerald-200">{t('Active')}</span>}
                    </td>
                    <td className="p-3 text-end">
                      <div className="flex justify-end gap-3">
                        {canUpdateJobTitles && jt.isActive !== false && (
                          <button type="button" onClick={() => startEditJobTitle(jt)} className="text-[10px] font-bold text-indigo-600 hover:underline">{t('Edit')}</button>
                        )}
                        {canDeleteJobTitles && (
                          <button type="button" onClick={() => handleToggleJobTitleActive(jt.id)} className="text-[10px] font-bold text-rose-500 hover:underline">
                            {jt.isActive === false ? t('Reactivate') : t('Deactivate')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(editingJobTitleId ? canUpdateJobTitles : canCreateJobTitles) && (
            <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
              <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">
                {editingJobTitleId ? t('Edit Job Title') : t('Create New Job Title')}
              </h4>
              <form onSubmit={handleSaveJobTitle} className="space-y-3">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Title')}</label>
                  <input type="text" required value={jtTitle} onChange={e => setJtTitle(e.target.value)}
                    placeholder={t('e.g. Sales Associate')}
                    className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Description')}</label>
                  <textarea value={jtDescription} onChange={e => setJtDescription(e.target.value)} rows={2}
                    placeholder={t('Optional — what this role covers')}
                    className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none" />
                </div>
                <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer pt-1">
                  <input type="checkbox" checked={jtIsSalesRole} onChange={e => setJtIsSalesRole(e.target.checked)}
                    className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5 mt-0.5" />
                  <span>{t('Counts as a sales role — employees with this title become selectable as Sales Associate on invoices.')}</span>
                </label>
                <div className="flex gap-2 pt-1">
                  {editingJobTitleId && (
                    <button type="button" onClick={clearJobTitleForm} className="px-4 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-bold text-xs">{t('Cancel')}</button>
                  )}
                  <button type="submit" className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl px-4 py-1.5 text-xs font-bold flex items-center justify-center gap-1 shadow-sm">
                    {editingJobTitleId ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                    {editingJobTitleId ? t('Save Changes') : t('Create Job Title')}
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 border border-slate-100 rounded-2xl overflow-hidden shadow-sm">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 text-slate-500">
                  <th className="p-3 text-start">{t('Employee')}</th>
                  <th className="p-3 text-start">{t('Job Title')}</th>
                  <th className="p-3 text-start">{t('Branch')}</th>
                  <th className="p-3 text-center">{t('Status')}</th>
                  <th className="p-3 text-end">{t('Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {employees.length === 0 ? (
                  <tr><td colSpan={5} className="p-6 text-center text-slate-400">{t('No employees onboarded yet.')}</td></tr>
                ) : employees.map(emp => (
                  <tr key={emp.id} className={`border-b border-slate-100 last:border-0 ${emp.isActive === false ? 'opacity-50' : ''}`}>
                    <td className="p-3 font-semibold text-slate-800 flex items-center gap-1.5">
                      <IdCard className="w-3.5 h-3.5 text-slate-300 shrink-0" /> {employeeLabel(emp)}
                    </td>
                    <td className="p-3 text-slate-600">{jobTitleName(emp.jobTitleId)}</td>
                    <td className="p-3 text-slate-600">{branchName(emp.branchId)}</td>
                    <td className="p-3 text-center">
                      {emp.isActive === false
                        ? <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-slate-100 text-slate-500 border border-slate-200">{t('Terminated')}</span>
                        : <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-emerald-50 text-emerald-700 border border-emerald-200">{t('Active')}</span>}
                    </td>
                    <td className="p-3 text-end">
                      <div className="flex justify-end gap-3">
                        {canUpdateEmployees && emp.isActive !== false && (
                          <button type="button" onClick={() => startEditEmployee(emp)} className="text-[10px] font-bold text-indigo-600 hover:underline">{t('Edit')}</button>
                        )}
                        {canDeleteEmployees && (
                          <button type="button" onClick={() => handleToggleEmployeeActive(emp.id)} className="text-[10px] font-bold text-rose-500 hover:underline">
                            {emp.isActive === false ? t('Reactivate') : t('Deactivate')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(editingEmployeeId ? canUpdateEmployees : canCreateEmployees) && (
            <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
              <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">
                {editingEmployeeId ? t('Edit Employee') : t('Onboard New Employee')}
              </h4>
              {jobTitles.filter(jt => jt.isActive !== false).length === 0 ? (
                <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-xl p-3">
                  {t('Create at least one active Job Title first — an employee must be onboarded with one.')}
                </p>
              ) : (
                <form onSubmit={handleSaveEmployee} className="space-y-3">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Full Name')}</label>
                    <input type="text" required value={empName} onChange={e => setEmpName(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Job Title')}</label>
                    <select required value={empJobTitleId} onChange={e => setEmpJobTitleId(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500">
                      <option value="">{t('-- Choose Job Title --')}</option>
                      {jobTitles.filter(jt => jt.isActive !== false).map(jt => (
                        <option key={jt.id} value={jt.id}>{jt.title}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Branch')}</label>
                    <select value={empBranchId} onChange={e => setEmpBranchId(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500">
                      <option value="">{t('Head Office (Company-wide)')}</option>
                      {branches.map(b => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Email')}</label>
                      <input type="email" value={empEmail} onChange={e => setEmpEmail(e.target.value)}
                        className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Phone')}</label>
                      <input type="text" value={empPhone} onChange={e => setEmpPhone(e.target.value)}
                        className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Hire Date')}</label>
                    <input type="date" value={empHireDate} onChange={e => setEmpHireDate(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                  </div>
                  {!editingEmployeeId && (
                    <p className="text-[10px] text-slate-400">{t('Employee Number is generated automatically on save and cannot be changed afterward.')}</p>
                  )}
                  <div className="flex gap-2 pt-1">
                    {editingEmployeeId && (
                      <button type="button" onClick={clearEmployeeForm} className="px-4 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-bold text-xs">{t('Cancel')}</button>
                    )}
                    <button type="submit" className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl px-4 py-1.5 text-xs font-bold flex items-center justify-center gap-1 shadow-sm">
                      {editingEmployeeId ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                      {editingEmployeeId ? t('Save Changes') : t('Onboard Employee')}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
