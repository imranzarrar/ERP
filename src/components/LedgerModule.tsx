import React from 'react';
import type { DatabaseState } from '../dbStore';
import ChartOfAccountsScreen from './ledger/ChartOfAccountsScreen';
import AccountMappingScreen from './ledger/AccountMappingScreen';
import JournalListScreen from './ledger/JournalListScreen';
import JournalFormScreen from './ledger/JournalFormScreen';
import LedgerReportsScreen, { type AccountFocus } from './ledger/LedgerReportsScreen';
import OpeningBalancesScreen from './ledger/OpeningBalancesScreen';
import DimensionsScreen from './ledger/DimensionsScreen';
import AccountDimensionRulesScreen from './ledger/AccountDimensionRulesScreen';
import ReportRunScreen from './ledger/ReportRunScreen';
import ReportDesignerScreen from './ledger/ReportDesignerScreen';
import PostingControlScreen from './ledger/PostingControlScreen';
import { PrintDocContext } from './ledger/ui';
import { ApprovalRulesScreen, MyApprovalsScreen } from './ledger/ApprovalScreens';
import { BankReconciliationScreen } from './ledger/BankReconciliationScreens';
import { SettlementEntryScreen, SettlementListScreen } from './ledger/SettlementScreens';
import { SubledgerAgingScreen, PartyLedgerScreen, type PartyFocus } from './ledger/SubledgerScreens';

export type LedgerFocus = { kind: 'manual' | 'entry'; id: string };

// The General Ledger section. Which screen shows is purely driven by the left menu (one tab id per screen); App.tsx owns the little bit of state
// that must survive a tab change (the journal being edited, the journal or account to open next).
function LedgerScreens({ db, tab, editJournalId, focus, accountFocus, onFocusConsumed, onNavigate, onFocusJournal, onEditJournal, onDrill, onDirtyChange }: {
  db: DatabaseState; tab: string; editJournalId?: string; focus: LedgerFocus | null; accountFocus: AccountFocus | null;
  onFocusConsumed: () => void; onNavigate: (tab: string) => void; onFocusJournal: (f: LedgerFocus) => void; onEditJournal: (id: string) => void;
  onDrill: (f: any) => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const [partyFocus, setPartyFocus] = React.useState<PartyFocus | null>(null);
  const openParty = (f: PartyFocus) => { setPartyFocus(f); onNavigate(f.kind === 'customer' ? 'gl-customer-ledger' : 'gl-vendor-ledger'); };
  const openEntry = (id: string) => { onFocusJournal({ kind: 'entry', id }); onNavigate('gl-journals'); };
  switch (tab) {
    case 'gl-approval-rules': return <ApprovalRulesScreen db={db} />;
    case 'gl-my-approvals': return <MyApprovalsScreen db={db} />;
    case 'gl-bank-reconciliation': return <BankReconciliationScreen db={db} />;
    case 'gl-receive-payment': return <SettlementEntryScreen db={db} kind="customer" />;
    case 'gl-receipts': return <SettlementListScreen db={db} kind="customer" onNew={() => onNavigate('gl-receive-payment')} />;
    case 'gl-pay-vendor': return <SettlementEntryScreen db={db} kind="vendor" />;
    case 'gl-vendor-payments': return <SettlementListScreen db={db} kind="vendor" onNew={() => onNavigate('gl-pay-vendor')} />;
    case 'gl-receivables-aging': return <SubledgerAgingScreen db={db} kind="customer" onOpenParty={openParty} />;
    case 'gl-payables-aging': return <SubledgerAgingScreen db={db} kind="vendor" onOpenParty={openParty} />;
    case 'gl-customer-ledger': return <PartyLedgerScreen db={db} kind="customer" focus={partyFocus} onFocusConsumed={() => setPartyFocus(null)} onOpenEntry={openEntry} />;
    case 'gl-vendor-ledger': return <PartyLedgerScreen db={db} kind="vendor" focus={partyFocus} onFocusConsumed={() => setPartyFocus(null)} onOpenEntry={openEntry} />;
    case 'gl-accounts': return <ChartOfAccountsScreen db={db} />;
    case 'gl-accounts-add': return <ChartOfAccountsScreen db={db} autoOpen="create" onDone={() => onNavigate('gl-accounts')} />;
    case 'gl-import': return <ChartOfAccountsScreen db={db} autoOpen="import" onDone={() => onNavigate('gl-accounts')} />;
    case 'gl-mapping': return <AccountMappingScreen db={db} />;
    case 'gl-journals':
      return <JournalListScreen db={db} mode="all" focus={focus} onFocusConsumed={onFocusConsumed} onNew={() => onNavigate('gl-journal-new')} onEdit={onEditJournal} />;
    case 'gl-pending':
      return <JournalListScreen db={db} mode="pending" focus={focus} onFocusConsumed={onFocusConsumed} onNew={() => onNavigate('gl-journal-new')} onEdit={onEditJournal} />;
    case 'gl-journal-new':
      return <JournalFormScreen db={db} editId={editJournalId} onDirtyChange={onDirtyChange}
        onDone={(savedId) => { if (savedId) onFocusJournal({ kind: 'manual', id: savedId }); onNavigate('gl-journals'); }} />;
    case 'gl-general-ledger': return <LedgerReportsScreen db={db} report="general-ledger" accountFocus={accountFocus} />;
    case 'gl-trial-balance': return <ReportRunScreen db={db} reportType="TrialBalance" onDrill={onDrill} onDesign={() => onNavigate('gl-report-designer')} />;
    case 'gl-income-statement': return <ReportRunScreen db={db} reportType="PnL" onDrill={onDrill} onDesign={() => onNavigate('gl-report-designer')} />;
    case 'gl-balance-sheet': return <ReportRunScreen db={db} reportType="BalanceSheet" onDrill={onDrill} onDesign={() => onNavigate('gl-report-designer')} />;
    case 'gl-cash-flow': return <ReportRunScreen db={db} reportType="CashFlow" onDrill={onDrill} onDesign={() => onNavigate('gl-report-designer')} />;
    case 'gl-equity-changes': return <ReportRunScreen db={db} reportType="ChangesInEquity" onDrill={onDrill} onDesign={() => onNavigate('gl-report-designer')} />;
    case 'gl-custom-reports': return <ReportRunScreen db={db} reportType="Custom" onDrill={onDrill} onDesign={() => onNavigate('gl-report-designer')} />;
    case 'gl-report-designer': return <ReportDesignerScreen db={db} />;
    case 'gl-reconciliation': return <LedgerReportsScreen db={db} report="reconciliation" />;
    case 'gl-opening': return <OpeningBalancesScreen db={db} />;
    case 'gl-posting-control': return <PostingControlScreen db={db} />;
    case 'gl-dim-types': return <DimensionsScreen db={db} mode="types" />;
    case 'gl-dim-values': return <DimensionsScreen db={db} mode="values" />;
    case 'gl-cost-centers': return <DimensionsScreen db={db} mode="cost-centers" />;
    case 'gl-dim-rules': return <AccountDimensionRulesScreen db={db} />;
    default: return null;
  }
}

export default function LedgerModule(props: Parameters<typeof LedgerScreens>[0] & { onPrintDoc: (type: 'SettlementVoucher' | 'JournalVoucher' | 'BankReconciliation', data: any) => void }) {
  const { onPrintDoc, ...rest } = props;
  return <PrintDocContext.Provider value={onPrintDoc}><LedgerScreens {...rest} /></PrintDocContext.Provider>;
}
