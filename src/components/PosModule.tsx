import React, { useState, useMemo } from 'react';
import { DatabaseState, saveInvoice, getAndIncrementCounter, calculateInvoiceTotals } from '../dbStore';
import { ProductService, Customer, PosShift, PosHeldInvoice, PosCartItem, TaxSlab, Invoice, BankAccount } from '../types';
import { Search, ShoppingCart, ShoppingBag, Trash2, Printer, Check, X, Pause, Play, Users, CreditCard, Banknote, UserPlus, LogOut, PackageSearch, Tag, Receipt, Maximize, Minimize } from 'lucide-react';
import { useTranslation, usePermissions } from '../hooks';
import StatusPill from './StatusPill';
import { generateId } from '../id';

interface PosModuleProps {
  db: DatabaseState;
  onUpdateDb: (newDb: DatabaseState | ((prev: DatabaseState) => DatabaseState)) => void;
  currentUser: any;
}

export default function PosModule({ db, onUpdateDb, currentUser, defaultTab = 'terminal', onClose }: PosModuleProps & { defaultTab?: 'terminal' | 'held' | 'history' | 'shifts', onClose?: () => void }) {
  const activeCompany = db.companies?.find((c:any) => c.id === (db.selectedCompanyId));
  const currency = activeCompany?.currency || 'SAR';
  const { t, isRTL } = useTranslation(db);
  const activeCompanyId = db.selectedCompanyId;
  const posSettings = db.companies?.find(c => c.id === activeCompanyId)?.posSettings || { autoPrint: true, maxImageSizeKB: 500 };

  const [fiscalMonths, setFiscalMonths] = React.useState<any[]>([]);
  const fetchMonths = async () => {
    if (!db.selectedCompanyId) return;
    try {
      const resp = await fetch(`/api/transactions/months?companyId=${db.selectedCompanyId}`);
      if (!resp.ok) {
        console.warn(`Failed to fetch fiscalMonths in PosModule (status ${resp.status})`);
        return;
      }
      const contentType = resp.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        console.warn("Received non-JSON response for fiscalMonths in PosModule");
        return;
      }
      const data = await resp.json();
      if (Array.isArray(data)) {
        setFiscalMonths(data);
      } else {
        console.warn("Received non-array data for fiscal months in PosModule:", data);
        setFiscalMonths([]);
      }
    } catch (e) {
      console.error("Failed to fetch fiscalMonths in PosModule:", e);
      setFiscalMonths([]);
    }
  };
  React.useEffect(() => { fetchMonths(); }, [db.selectedCompanyId]);

  // Shift Management
  const activeShift = db.posShifts?.find(s => s.companyId === activeCompanyId && s.userId === currentUser?.id && s.status === 'open');
  const { can } = usePermissions(currentUser);

  const [startingCash, setStartingCash] = useState<string>('0');
  const [activeTab, setActiveTab] = useState<'terminal' | 'held' | 'history' | 'shifts'>(defaultTab);
  const [cart, setCart] = useState<PosCartItem[]>([]);
  const [holdCustomerId, setHoldCustomerId] = useState<string>('');

  React.useEffect(() => { setActiveTab(defaultTab); }, [defaultTab]);

  const handleStartShift = () => {
    // Check for open fiscal month
    const openMonth = fiscalMonths?.find(m => m.companyId === activeCompanyId && m.status === 'Open');
    if (!openMonth) {
      alert(t('Cannot start a shift without an open fiscal month. Please open a fiscal month first.'));
      return;
    }
    const newShift: PosShift = {
      // pos_shifts.id is a real Postgres `uuid` column (BACKLOG.md item 25's schema
      // migration) — this legacy `shift-${Date.now()}` string isn't a valid UUID, so
      // every new shift silently failed to persist ("invalid input syntax for type
      // uuid") until the cloudError banner fix made that failure visible at all.
      id: generateId(),
      companyId: activeCompanyId,
      userId: currentUser.id,
      startTime: new Date().toISOString(),
      startCash: parseFloat(startingCash) || 0,
      status: 'open'
    };
    onUpdateDb(prev => ({ ...prev, posShifts: [...(prev.posShifts || []), newShift] }));
  };

  // Basic layout if no shift - only block terminal access
  if (!activeShift && activeTab === 'terminal') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[70vh] bg-slate-50 p-6 rounded-3xl border border-slate-200">
        <div className="bg-white p-10 rounded-3xl shadow-xl max-w-md w-full text-center space-y-6">
          <div className="w-20 h-20 bg-indigo-100 rounded-full flex items-center justify-center mx-auto">
            <ShoppingBag className="w-10 h-10 text-indigo-600" />
          </div>
          <h2 className="text-2xl font-extrabold text-slate-900">{t('Start Cashier Shift')}</h2>
          <p className="text-slate-500 text-sm">{t('Enter the opening cash amount in the drawer to begin your point-of-sale shift.')}</p>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-xl font-bold text-slate-400">{currency}</span>
            <input type="number" min="0" step="0.01" value={startingCash} onChange={e => setStartingCash(e.target.value)} className="w-full text-center text-3xl font-bold bg-slate-50 border border-slate-200 rounded-2xl py-4 focus:ring-4 focus:ring-indigo-600/20" placeholder="0.00" />
          </div>
          <button onClick={handleStartShift} className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-2xl shadow-lg transition-all text-lg flex items-center justify-center gap-2">
            <Play className="w-6 h-6" /> {t('Open Register')}
          </button>
        </div>
      </div>
    );
  }


  
  
  
  
  
  

  return (
    <div className="flex flex-col w-full h-full">
      <div className="flex items-center gap-2 p-2 bg-slate-900 text-white rounded-t-xl mx-2 mt-2">
        {can('pos.terminal') && (
          <button onClick={() => setActiveTab('terminal')} className={`px-4 py-2 rounded-lg font-bold text-sm ${activeTab === 'terminal' ? 'bg-indigo-600' : 'hover:bg-slate-800'}`}>{t('Terminal')}</button>
        )}
        {can('pos.access') && (
          <button onClick={() => setActiveTab('held')} className={`px-4 py-2 rounded-lg font-bold text-sm ${activeTab === 'held' ? 'bg-indigo-600' : 'hover:bg-slate-800'}`}>{t('Pending (Held)')}</button>
        )}
        {can('pos.history') && (
          <button onClick={() => setActiveTab('history')} className={`px-4 py-2 rounded-lg font-bold text-sm ${activeTab === 'history' ? 'bg-indigo-600' : 'hover:bg-slate-800'}`}>{t('Sales History')}</button>
        )}
        {can('pos.shifts') && (
          <button onClick={() => setActiveTab('shifts')} className={`px-4 py-2 rounded-lg font-bold text-sm ${activeTab === 'shifts' ? 'bg-indigo-600' : 'hover:bg-slate-800'}`}>{t('Shifts & Z-Reports')}</button>
        )}
      </div>
      <div className="flex-1 overflow-hidden relative bg-white">
        {activeTab === 'terminal' && <PosMainApp db={db} onUpdateDb={onUpdateDb} currentUser={currentUser} activeShift={activeShift} activeCompanyId={activeCompanyId} posSettings={posSettings} cart={cart} setCart={setCart} holdCustomerId={holdCustomerId} setHoldCustomerId={setHoldCustomerId} onClose={onClose} fiscalMonths={fiscalMonths} />}
        {activeTab === 'held' && <PosHeldInvoices db={db} onUpdateDb={onUpdateDb} currentUser={currentUser} activeCompanyId={activeCompanyId} onResume={(heldInvoice: any) => { setCart(heldInvoice.items); setHoldCustomerId(heldInvoice.customerId); setActiveTab('terminal'); }} restricted={true} />}

        {activeTab === 'history' && <PosSalesHistory db={db} activeCompanyId={activeCompanyId} currentUser={currentUser} restricted={true} />}

        {activeTab === 'shifts' && <PosShiftsHistory db={db} activeCompanyId={activeCompanyId} currentUser={currentUser} />}
      </div>
    </div>
  );

}

// Will write PosMainApp in next step to avoid payload too large

function PosMainApp({ db, onUpdateDb, currentUser, activeShift, activeCompanyId, posSettings, cart, setCart, holdCustomerId, setHoldCustomerId, onClose, fiscalMonths }: any) {
  const { t, isRTL } = useTranslation(db);

  // Up to 3 fiscal months can be open concurrently now (see server/routes/transactions.ts,
  // MAX_OPEN_FISCAL_MONTHS). The old `fiscalMonths.find(m => m.status === 'Open')` pattern
  // resolved to a single arbitrary open month rather than specifically today's own month, which
  // was harmless when at most one month could ever be open, but silently misdated real POS sale
  // invoices (backdating to the 1st of a DIFFERENT still-open month) once several can be open at
  // once and today's month isn't necessarily the one that `.find()` happens to return. Mirrors
  // isDateInOpenMonth/getOpenMonths in src/dbStore.ts, applied to this component's own
  // independently-fetched `fiscalMonths` state.
  const getPosSaleDate = (): string => {
    const todayStr = new Date().toISOString().split('T')[0];
    const todayMonthId = todayStr.substring(0, 7);
    const openMonthsSorted = (fiscalMonths || [])
      .filter((m: any) => m.status === 'Open' && m.companyId === activeCompanyId)
      .sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
    if (openMonthsSorted.length === 0) return todayStr;
    const todayIsOpen = openMonthsSorted.some((m: any) => m.id === todayMonthId);
    return todayIsOpen ? todayStr : `${openMonthsSorted[0].id}-01`;
  };
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  
  const [showHoldModal, setShowHoldModal] = useState(false);
  const [showPayModal, setShowPayModal] = useState(false);
  const [showCloseShiftModal, setShowCloseShiftModal] = useState(false);
  const [isReturnMode, setIsReturnMode] = useState(false);
  const [actualCash, setActualCash] = useState<string>('');

  
  const [payBankId, setPayBankId] = useState<string>('cash');
  const [payCustomerId, setPayCustomerId] = useState<string>('');
  const [receivedAmount, setReceivedAmount] = useState<string>('');
  const receivedAmountRef = React.useRef<HTMLInputElement>(null);
  
  React.useEffect(() => {
    if (showPayModal) {
      setTimeout(() => {
        receivedAmountRef.current?.focus();
      }, 100);
    }
  }, [showPayModal]);
  const activeCompany = db.companies?.find((c:any) => c.id === activeCompanyId);
  const currency = activeCompany?.currency || 'SAR';
  
  const products = (db.products || []).filter((p: ProductService) => p.companyId === activeCompanyId);
  const categories = ['All', ...Array.from(new Set(products.map((p: ProductService) => p.category).filter(Boolean)))];

  const filteredProductServices = products.filter((p: ProductService) => {
    if (selectedCategory !== 'All' && p.category !== selectedCategory) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return p.name.toLowerCase().includes(q) || (p.sku && p.sku.toLowerCase().includes(q)) || (p.barcode && p.barcode.toLowerCase().includes(q));
    }
    return true;
  });

  const handleAddToCart = (product: ProductService) => {
    const qty = isReturnMode ? -1 : 1;
    setCart(prev => {
      const existing = prev.find(item => item.productId === product.id);
      if (existing) {
        return prev.map(item => item.productId === product.id ? { ...item, quantity: item.quantity + qty, total: (item.quantity + qty) * item.unitPrice } : item);
      }
      return [...prev, { productId: product.id, productName: product.name, quantity: qty, unitPrice: product.unitPrice, discount: 0, total: qty * product.unitPrice }];
    });
  };

  const handleUpdateCartItem = (productId: string, delta: number) => {
    setCart(prev => prev.map(item => {
      if (item.productId === productId) {
        const newQ = item.quantity + delta; // Allow negative for returns, or zero to remove
        return { ...item, quantity: newQ, total: newQ * item.unitPrice };
      }
      return item;
    }).filter(item => item.quantity !== 0));
  };

  const handleRemoveCartItem = (productId: string) => {
    setCart(prev => prev.filter(item => item.productId !== productId));
  };

  const subtotal = cart.reduce((sum, item) => sum + (item.total || 0), 0);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (showCloseShiftModal) return;
      if (e.key === 'Escape') {
        if (showHoldModal || showPayModal || showCloseShiftModal) {
          setShowHoldModal(false);
          setShowPayModal(false);
          setShowCloseShiftModal(false);
        } else if (!document.fullscreenElement) {
          if (onClose) onClose();
        }
      }
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        if (!showPayModal && cart.length > 0) setShowPayModal(true);
        else if (showPayModal && payBankId) handlePayInvoice();
      }
      if (e.ctrlKey && e.key === 'h') {
        e.preventDefault();
        if (cart.length > 0 && !showPayModal) setShowHoldModal(true);
      }
      if (e.ctrlKey && e.key === 'Backspace') {
        e.preventDefault();
        if (cart.length > 0 && !showPayModal && !showHoldModal) setCart([]);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [cart, showPayModal, showHoldModal, payBankId, holdCustomerId, showCloseShiftModal]);
  
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(err => {
        alert(`${t("Error attempting to enable fullscreen:")} ${err.message}`);
      });
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };
  
  React.useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);
  const totalDiscount = cart.reduce((sum, item) => sum + (item.discount || 0), 0);
  // The cart/pay-modal total shown to (and collected from) the cashier must be the
  // SAME tax-inclusive grand total the invoice actually gets saved with (computed via
  // calculateInvoiceTotals, exactly like dbStore.ts's saveInvoice does internally) —
  // previously this was pre-tax (subtotal - discount only), so the cashier quoted a
  // lower figure than the VAT-inclusive amount the system recorded for the same sale.
  //
  // Which slab to actually apply was ALSO wrong (found live, while verifying the fix
  // above): `db.taxSlabs?.[0]?.id` grabs whatever slab happens to be first in the
  // array — for this company that's "Exempt (0%)", so every POS sale was silently
  // recording zero VAT regardless of the item, not just displaying the wrong total.
  // POS has no per-line tax picker (unlike Invoice), so it needs a real default: prefer
  // this company's own standard-rate slab, else the shared 15% standard slab, else
  // fall back to the old (wrong but previously-existing) first-slab behavior only if
  // no standard rate can be found at all.
  const posTaxSlabId =
    db.taxSlabs?.find(t => t.companyId === activeCompanyId && Number(t.percentage) === 15)?.id ||
    db.taxSlabs?.find(t => !t.companyId && Number(t.percentage) === 15)?.id ||
    db.taxSlabs?.[0]?.id || '';
  const cartTotals = calculateInvoiceTotals(
    db,
    cart.map((item: PosCartItem) => ({ unitCost: item.unitPrice, quantity: item.quantity, discountAmount: item.discount || 0 })),
    posTaxSlabId,
    0
  );
  const taxAmount = cartTotals.taxAmount;
  const taxPercentage = cartTotals.percentage;
  const total = cartTotals.grandTotal;

  const handleHoldInvoice = () => {
    if (!holdCustomerId) return alert(t('Customer selection is mandatory for pending (held) payments.'));
    const newHold: PosHeldInvoice = {
      // Same real-uuid-column issue as handleStartShift above — fixed identically.
      id: generateId(),
      shiftId: activeShift.id,
      companyId: activeCompanyId,
      customerId: holdCustomerId,
      items: cart,
      createdAt: new Date().toISOString(),
      reference: `POS-HOLD-${Math.floor(Math.random() * 10000)}`
    };
    onUpdateDb((prev: any) => ({ ...prev, posHeldInvoices: [...(prev.posHeldInvoices || []), newHold] }));
    setCart([]);
    setShowHoldModal(false);
  };

  const handlePayInvoice = () => {
    if (!payBankId) return alert(t('Please select a payment method (Bank/Cash).'));

    // Guard against confirming a sale for less cash than the (tax-inclusive) total
    // actually due — previously any received amount (including a blank/0 field) was
    // accepted and the full grandTotal was still recorded as amountPaid regardless of
    // what was actually collected from the customer.
    const receivedNum = parseFloat(receivedAmount) || 0;
    if (receivedNum < total - 0.01) {
      return alert(t('Received amount is less than the total due. Please collect the full amount before confirming payment.'));
    }

    let finalBankId = payBankId;
    if (finalBankId === 'cash') {
       // Find the default bank for activeCompanyId
       const defaultBank = (db.banks || []).find((b: any) => b.companyId === activeCompanyId && b.isDefault);
       if (defaultBank) {
         finalBankId = defaultBank.id;
       } else {
         // Fallback to the first bank of the company
         const firstBank = (db.banks || []).find((b: any) => b.companyId === activeCompanyId);
         if (firstBank) {
           finalBankId = firstBank.id;
         } else {
            return alert(t('No bank accounts configured. Please configure at least one bank account.'));
         }
       }
    }

    const invData = {
      companyId: activeCompanyId,
      isPosSale: true,
      shiftId: activeShift.id,
      customerId: payCustomerId || (db.customers || []).find((c: any) => c.companyId === activeCompanyId && c.name.toLowerCase().includes('walk-in'))?.id || (db.customers || []).find((c: any) => c.companyId === activeCompanyId)?.id || '',
      taxSlabId: posTaxSlabId,
      bankId: finalBankId,
      date: getPosSaleDate(),
      paymentStatus: 'Paid',
      paymentDate: getPosSaleDate(),
      notes: t('POS Sale'),
      status: 'Active',
      originQuotationId: null,
      items: cart.map(item => ({
        id: `inv-item-${Math.random()}`,
        description: item.productName || item.productId,
        unitCost: item.unitPrice,
        quantity: item.quantity,
        discountAmount: item.discount
      }))
    };
    console.log('Attempting to save invoice with data:', JSON.stringify(invData, null, 2));
    const { db: updatedDb, error } = saveInvoice(db, invData as any);
    if (error) return alert(error);
    onUpdateDb(updatedDb);
    setCart([]);
    setShowPayModal(false);
    setReceivedAmount('');
    if (posSettings.autoPrint) {
      setTimeout(() => alert(t('Receipt printing simulated!')), 500);
    }
  };

  const handleCloseShiftConfirm = () => {
    const actual = parseFloat(actualCash) || 0;

    // Expected cash = starting float + this shift's sales (same "Total Sales" figure
    // PosShiftsHistory's calculateShiftSales computes: sum of amountPaid across this
    // shift's non-cancelled invoices) — NOT the counted `actual` figure itself. Setting
    // expectedCash to the same value as endCash (the old behavior) made
    // variance = endCash - expectedCash mathematically always zero, defeating the
    // entire point of a cash-drawer variance/shortage report.
    const shiftSales = (db.invoices || [])
      .filter((i: Invoice) => i.companyId === activeCompanyId && i.shiftId === activeShift.id && i.status !== 'Cancelled')
      .reduce((sum: number, inv: Invoice) => sum + (inv.amountPaid || 0), 0);
    const expected = (activeShift.startCash || 0) + shiftSales;

    onUpdateDb((prev: any) => ({
      ...prev,
      posShifts: prev.posShifts.map((s: PosShift) => s.id === activeShift.id ? { ...s, status: 'closed', endTime: new Date().toISOString(), endCash: actual, expectedCash: expected } : s)
    }));
    setShowCloseShiftModal(false);
  };

  const renderProductServiceGrid = () => (
    <div className="flex-1 flex flex-col bg-slate-50 h-[calc(100vh-100px)] overflow-hidden">
      {/* Top Bar: Search & Categories */}
      <div className="bg-white border-b border-slate-200 p-4 shrink-0 flex flex-col gap-4">
        <div className="relative flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input 
              type="text" 
              placeholder={t("Search by name, SKU, or Barcode...")} 
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-3 bg-slate-100 border-none rounded-xl text-slate-900 focus:ring-2 focus:ring-indigo-600 outline-none"
            />
          </div>
          <button onClick={toggleFullscreen} className="p-3 bg-slate-100 text-slate-600 rounded-xl hover:bg-slate-200 transition-colors" title={t("Toggle Fullscreen (Esc to exit to Dashboard)")}>
            {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
          </button>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
          {categories.map((c: string) => (
            <button 
              key={c}
              onClick={() => setSelectedCategory(c)}
              className={`px-4 py-2 rounded-xl font-bold whitespace-nowrap transition-all ${selectedCategory === c ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
            >
              {t(c)}
            </button>
          ))}
        </div>
      </div>
      
      {/* ProductService Grid */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {filteredProductServices.map((p: ProductService) => (
            <button 
              key={p.id} 
              onClick={() => handleAddToCart(p)}
              className="bg-white border border-slate-200 rounded-2xl overflow-hidden hover:shadow-lg hover:border-indigo-300 transition-all text-left flex flex-col h-48 active:scale-95"
            >
              <div className="h-28 bg-slate-100 w-full flex flex-col items-center justify-center overflow-hidden relative">
                {p.base64Image ? (
                   <img src={p.base64Image} alt={p.name} className="w-full h-full object-cover" />
                ) : (
                  <PackageSearch className="w-10 h-10 text-slate-300" />
                )}
                {p.category && <span className="absolute top-2 left-2 bg-white/90 backdrop-blur-sm text-[10px] font-bold px-2 py-0.5 rounded-full text-slate-600 shadow-sm">{t(p.category)}</span>}
              </div>
              <div className="p-3 flex-1 flex flex-col justify-between">
                <div className="font-bold text-slate-800 leading-tight line-clamp-2">{p.name}</div>
                <div className="font-extrabold text-indigo-700">{db.companies?.find((c:any) => c.id === activeCompanyId)?.currency || 'SAR'} {Number(p.unitPrice || 0).toFixed(2)}</div>
              </div>
            </button>
          ))}
          {filteredProductServices.length === 0 && (
            <div className="col-span-full py-20 text-center text-slate-400">
              <PackageSearch className="w-16 h-16 mx-auto mb-4 opacity-20" />
              <p>{t("No products found in this category.")}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const renderCart = () => (
    <div className="w-96 bg-white border-l border-slate-200 h-[calc(100vh-100px)] flex flex-col shrink-0 shadow-[-10px_0_20px_-10px_rgba(0,0,0,0.05)] z-10">
      <div className="p-4 border-b border-slate-100 flex items-center justify-between shrink-0 bg-slate-50/50">
        <h2 className="font-extrabold text-slate-900 flex items-center gap-2">
          <ShoppingCart className="w-5 h-5 text-indigo-600" /> {t("Current Sale")}
        </h2>
        <button onClick={() => setShowCloseShiftModal(true)} className="px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-50 rounded-xl transition flex items-center gap-1">
          <LogOut className="w-3.5 h-3.5" /> {t("End Shift")}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {cart.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-400 space-y-4">
            <ShoppingCart className="w-12 h-12 opacity-20" />
            <p className="font-medium text-sm">{t("Cart is empty")}</p>
          </div>
        ) : (
          cart.map(item => (
            <div key={item.productId} className="bg-white border border-slate-100 rounded-2xl p-3 shadow-sm flex flex-col gap-2 relative group">
              <div className="flex justify-between items-start pr-6">
                <div className="font-bold text-slate-800 text-sm leading-tight">{item.productName}</div>
                <div className="font-extrabold text-indigo-600 text-sm">{currency} {(item.total || 0).toFixed(2)}</div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 bg-slate-50 rounded-xl p-1 border border-slate-200">
                  <button onClick={() => handleUpdateCartItem(item.productId, -1)} className="w-7 h-7 flex items-center justify-center bg-white rounded-lg shadow-sm font-bold text-slate-600 hover:text-indigo-600 active:scale-95">-</button>
                  <span className="font-extrabold text-slate-900 text-sm min-w-[20px] text-center">{item.quantity}</span>
                  <button onClick={() => handleUpdateCartItem(item.productId, 1)} className="w-7 h-7 flex items-center justify-center bg-white rounded-lg shadow-sm font-bold text-slate-600 hover:text-indigo-600 active:scale-95">+</button>
                </div>
                <div className="text-xs font-medium text-slate-400">
                  @ {currency} {Number(item.unitPrice || 0).toFixed(2)}
                </div>
              </div>
              <button onClick={() => handleRemoveCartItem(item.productId)} className="absolute top-2 right-2 p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition opacity-0 group-hover:opacity-100">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))
        )}
      </div>

      <div className="p-4 bg-slate-50 border-t border-slate-200 shrink-0 space-y-4 rounded-tl-3xl">
        <div className="space-y-1">
          <div className="flex justify-between text-sm text-slate-500 font-medium">
            <span>{t("Subtotal")}</span>
            <span>{currency} {subtotal.toFixed(2)}</span>
          </div>
          {totalDiscount > 0 && (
            <div className="flex justify-between text-sm text-rose-500 font-semibold">
              <span>{t("Discount")}</span>
              <span>-{currency} {totalDiscount.toFixed(2)}</span>
            </div>
          )}
          {taxAmount > 0 && (
            <div className="flex justify-between text-sm text-slate-500 font-medium">
              <span>{t("VAT")} ({taxPercentage}%)</span>
              <span>{currency} {taxAmount.toFixed(2)}</span>
            </div>
          )}
          <div className="flex justify-between text-2xl font-black text-slate-900 mt-2">
            <span>{t("Total")}</span>
            <span>{currency} {total.toFixed(2)}</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button 
            disabled={cart.length === 0}
            onClick={() => setShowHoldModal(true)} 
            className="py-3 bg-amber-100 text-amber-700 hover:bg-amber-200 font-bold rounded-xl flex items-center justify-center gap-2 transition disabled:opacity-50"
          >
            <Pause className="w-4 h-4" /> {t("Hold")}
          </button>
          <button 
            disabled={cart.length === 0}
            onClick={() => setCart([])} 
            className="py-3 bg-slate-200 text-slate-600 hover:bg-slate-300 font-bold rounded-xl flex items-center justify-center gap-2 transition disabled:opacity-50"
          >
            <X className="w-4 h-4" /> {t("Void")}
          </button>
        </div>
        <button 
          disabled={cart.length === 0}
          onClick={() => setShowPayModal(true)} 
          className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold rounded-2xl shadow-lg shadow-indigo-600/20 text-lg flex items-center justify-center gap-2 transition active:scale-95 disabled:opacity-50"
        >
          <CreditCard className="w-6 h-6" /> {t("Pay Now")}
        </button>
      </div>
    </div>
  );

  return (
    <div ref={containerRef} className="flex w-full h-full overflow-hidden bg-slate-50 relative">
      <div className="absolute top-4 right-4 z-5 pointer-events-none">
        <div className="bg-white/90 backdrop-blur-sm p-3 rounded-xl shadow-lg border border-slate-200 pointer-events-auto opacity-30 hover:opacity-100 transition-opacity flex flex-col gap-1 text-[10px] font-bold text-slate-500">
           <div className="flex items-center gap-2"><kbd className="bg-slate-100 px-1 py-0.5 rounded border border-slate-200">Ctrl+Enter</kbd> {t("Pay")}</div>
           <div className="flex items-center gap-2"><kbd className="bg-slate-100 px-1 py-0.5 rounded border border-slate-200">Ctrl+H</kbd> {t("Hold")}</div>
           <div className="flex items-center gap-2"><kbd className="bg-slate-100 px-1 py-0.5 rounded border border-slate-200">Ctrl+Backspace</kbd> {t("Void")}</div>
           <div className="flex items-center gap-2"><kbd className="bg-slate-100 px-1 py-0.5 rounded border border-slate-200">Esc</kbd> {t("Close Modals / Exit FS")}</div>
           <button onClick={toggleFullscreen} className="mt-1 text-indigo-600 hover:text-indigo-700 bg-indigo-50 py-1 rounded">{isFullscreen ? t('Exit Fullscreen') : t('Enter Fullscreen')}</button>
        </div>
      </div>
      {renderProductServiceGrid()}
      {renderCart()}

      {/* HOLD MODAL */}
      {showHoldModal && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-3xl p-6 shadow-2xl max-w-md w-full animate-in zoom-in-95 duration-200">
            <h3 className="text-xl font-extrabold text-slate-900 mb-4 flex items-center gap-2"><Pause className="w-5 h-5 text-amber-500"/> {t("Hold Invoice (Pending)")}</h3>
            <p className="text-sm text-slate-600 mb-6 font-medium">{t("Please select a customer. This is mandatory for pending payments to save for future reference.")}</p>
            
            <div className="mb-6">
              <label className="block text-sm font-bold text-slate-700 mb-2">{t("Select Customer *")}</label>
              <select 
                value={holdCustomerId} 
                onChange={e => setHoldCustomerId(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl px-4 py-3 focus:ring-2 focus:ring-indigo-600"
              >
                <option value="">{t("-- Choose Customer --")}</option>
                {(db.customers || []).filter((c:any) => c.companyId === activeCompanyId).map((c:any) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.phone})</option>
                ))}
              </select>
            </div>

            <div className="flex gap-3">
              <button onClick={() => setShowHoldModal(false)} className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition">{t("Cancel")}</button>
              <button onClick={handleHoldInvoice} className="flex-1 py-3 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-xl shadow-lg transition">{t("Save Pending")}</button>
            </div>
          </div>
        </div>
      )}

      {/* PAY MODAL */}
      {showPayModal && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-3xl p-6 shadow-2xl max-w-md w-full animate-in zoom-in-95 duration-200">
            <h3 className="text-xl font-extrabold text-slate-900 mb-6 flex items-center gap-2"><Banknote className="w-6 h-6 text-emerald-500"/> {t("Complete Payment")}</h3>
            
            <div className="space-y-5">
              <div className="bg-slate-50 p-4 rounded-2xl flex justify-between items-center border border-slate-100">
                <div>
                  <span className="font-bold text-slate-600 text-sm block">{t("Amount Due")}</span>
                  {taxAmount > 0 && (
                    <span className="text-[10px] text-slate-400 font-medium">{t("Incl. VAT")} ({taxPercentage}%): {currency} {taxAmount.toFixed(2)}</span>
                  )}
                </div>
                <span className="text-3xl font-black text-slate-900">{currency} {total.toFixed(2)}</span>
              </div>

              <div>
                <label className="block text-sm font-bold text-slate-700 mb-2">{t("Payment Method / Bank Account *")}</label>
                <select 
                  value={payBankId} 
                  onChange={e => setPayBankId(e.target.value)}
                  className="w-full bg-white border border-slate-200 text-slate-900 text-sm rounded-xl px-4 py-3 focus:ring-2 focus:ring-indigo-600 shadow-sm"
                >
                  <option value="">{t("-- Select Register/Bank --")}</option>
                  <option value="cash">{t("Cash Register (Default)")}</option>
                  {(db.banks || []).filter((b:any) => b.companyId === activeCompanyId && b.isActive).map((b:any) => (
                    <option key={b.id} value={b.id}>{b.bankName} - {b.accountTitle}</option>
                  ))}
                </select>
              </div>

              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="block text-sm font-bold text-slate-700 mb-2">{t("Received Amount")}</label>
                  <input
                    ref={receivedAmountRef}
                    type="number"
                    min="0"
                    step="0.01"
                    value={receivedAmount}
                    onChange={(e) => setReceivedAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-white border border-slate-200 text-slate-900 text-lg font-bold rounded-xl px-4 py-3 focus:ring-2 focus:ring-indigo-600 shadow-sm"
                  />
                </div>
                <div className="flex-1 bg-indigo-50 p-4 rounded-xl border border-indigo-100 flex flex-col justify-center items-center">
                  <span className="text-sm font-bold text-indigo-600">{t("Change (Rounded)")}</span>
                  <span className="text-2xl font-black text-indigo-900">
                    {currency} {Math.max(0, Math.round((parseFloat(receivedAmount) || 0) - total))}
                  </span>
                </div>
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-2">{t("Customer (Optional for paid)")}</label>
                <select 
                  value={payCustomerId} 
                  onChange={e => setPayCustomerId(e.target.value)}
                  className="w-full bg-white border border-slate-200 text-slate-900 text-sm rounded-xl px-4 py-3 focus:ring-2 focus:ring-indigo-600 shadow-sm"
                >
                  <option value="">{t("Walk-in Customer (Default)")}</option>
                  {(db.customers || []).filter((c:any) => c.companyId === activeCompanyId).map((c:any) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex gap-3 mt-8">
              <button onClick={() => setShowPayModal(false)} className="flex-1 py-3.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition">{t("Cancel")}</button>
              <button onClick={handlePayInvoice} className="flex-[2] py-3.5 bg-emerald-500 hover:bg-emerald-600 text-white font-extrabold rounded-xl shadow-lg shadow-emerald-500/20 transition flex items-center justify-center gap-2">
                <Check className="w-5 h-5" /> {t("Confirm Payment")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CLOSE SHIFT MODAL */}
      {showCloseShiftModal && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-3xl p-6 shadow-2xl max-w-sm w-full animate-in zoom-in-95 duration-200 text-center">
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <LogOut className="w-8 h-8 text-red-600" />
            </div>
            <h3 className="text-xl font-extrabold text-slate-900 mb-2">{t("End Shift")}</h3>
            <p className="text-sm text-slate-500 font-medium mb-6">{t("Please count the cash in drawer and enter the total below.")}</p>
            
            <div className="mb-6">
              <label className="block text-sm font-bold text-slate-700 mb-2 text-left">{t("Actual Cash in Drawer")}</label>
              <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-xl font-bold text-slate-400">{currency}</span>
              <input 
                type="number" min="0" step="0.01" 
                value={actualCash} 
                onChange={e => setActualCash(e.target.value)}
                className="w-full text-center text-3xl font-bold bg-slate-50 border border-slate-200 rounded-2xl py-4 focus:ring-4 focus:ring-red-600/20" 
                placeholder="0.00" 
              />
              </div>
            </div>

            <div className="flex gap-3">
              <button onClick={() => setShowCloseShiftModal(false)} className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition">{t("Cancel")}</button>
              <button onClick={handleCloseShiftConfirm} className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl shadow-lg shadow-red-600/20 transition">{t("Close Shift")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PosHeldInvoices({ db, onUpdateDb, currentUser, activeCompanyId, onResume, restricted }: any) {
  const { t } = useTranslation(db);
  const isAdmin = currentUser?.role === 'admin' || currentUser?.isSuperAdmin === true;
  const heldInvoices = (db.posHeldInvoices || []).filter((h: any) => {
    if (h.companyId !== activeCompanyId) return false;
    if (restricted && !isAdmin) {
        // Find shift to check userId
        const shift = db.posShifts?.find(s => s.id === h.shiftId);
        return shift && shift.userId === currentUser.id;
    }
    return true;
  });
  return (
    <div className="p-6">
      <h2 className="text-xl font-bold mb-4">{t("Pending (Held) Invoices")}</h2>
      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="p-4 font-bold text-slate-700">{t("Reference")}</th>
              <th className="p-4 font-bold text-slate-700">{t("Date")}</th>
              <th className="p-4 font-bold text-slate-700">{t("Customer")}</th>
              <th className="p-4 font-bold text-slate-700">{t("Items")}</th>
              <th className="p-4 font-bold text-slate-700 text-right">{t("Actions")}</th>
            </tr>
          </thead>
          <tbody>
            {heldInvoices.map((h: any) => {
              const cust = db.customers?.find((c: any) => c.id === h.customerId);
              return (
                <tr key={h.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="p-4 font-bold text-indigo-600">{h.reference}</td>
                  <td className="p-4 text-slate-600">{new Date(h.createdAt).toLocaleString()}</td>
                  <td className="p-4 text-slate-800">{cust?.name || t("Unknown")}</td>
                  <td className="p-4 text-slate-600">{h.items.length} {t("items")}</td>
                  <td className="p-4 text-right">
                    <button onClick={() => { onResume(h); onUpdateDb(prev => ({...prev, posHeldInvoices: prev.posHeldInvoices.filter((inv:any) => inv.id !== h.id)})) }} className="px-3 py-1.5 bg-indigo-50 text-indigo-700 font-bold text-xs rounded-lg hover:bg-indigo-100">{t("Resume")}</button>
                  </td>
                </tr>
              );
            })}
            {heldInvoices.length === 0 && (
              <tr><td colSpan={5} className="p-8 text-center text-slate-400">{t("No pending invoices.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}


function PosSalesHistory({ db, activeCompanyId, currentUser, restricted }: any) {
  const { t } = useTranslation(db);
  const activeCompany = db.companies?.find((c:any) => c.id === activeCompanyId);
  const currency = activeCompany?.currency || 'SAR';
  const isAdmin = currentUser?.role === 'admin' || currentUser?.isSuperAdmin === true;
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const posInvoices = db.invoices.filter((i: any) => {
    if (i.companyId !== activeCompanyId || !i.shiftId) return false;
    
    if (restricted && !isAdmin) {
        const shift = db.posShifts?.find(s => s.id === i.shiftId);
        if (!shift || shift.userId !== currentUser.id) return false;
        
        // Date restriction: today or yesterday
        const invoiceDate = new Date(i.date);
        return invoiceDate >= yesterday && invoiceDate <= today;
    }
    return true;
  });
  return (
    <div className="p-6">
      <h2 className="text-xl font-bold mb-4">{t("POS Sales History")}</h2>
      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="p-4 font-bold text-slate-700">{t("Invoice No")}</th>
              <th className="p-4 font-bold text-slate-700">{t("Date")}</th>
              <th className="p-4 font-bold text-slate-700">{t("Customer")}</th>
              <th className="p-4 font-bold text-slate-700">{t("Total")}</th>
              <th className="p-4 font-bold text-slate-700">{t("Status")}</th>
            </tr>
          </thead>
          <tbody>
            {posInvoices.map((inv: any) => {
              const cust = db.customers?.find((c: any) => c.id === inv.customerId);
              return (
                <tr key={inv.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="p-4 font-bold text-indigo-600">{inv.invoiceNumber}</td>
                  <td className="p-4 text-slate-600">{new Date(inv.date).toLocaleDateString()}</td>
                  <td className="p-4 text-slate-800">{cust?.name || t("Walk-in")}</td>
                  <td className="p-4 font-bold text-slate-900">{currency} {calculateInvoiceTotals(db, inv.items, inv.taxSlabId, inv.discountPercentage).grandTotal.toFixed(2)}</td>
                  <td className="p-4"><StatusPill tone={inv.status === 'Active' ? 'good' : 'critical'}>{t(inv.status)}</StatusPill></td>
                </tr>
              );
            })}
            {posInvoices.length === 0 && (
              <tr><td colSpan={5} className="p-8 text-center text-slate-400">{t("No POS invoices found.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}


function PosShiftsHistory({ db, activeCompanyId, currentUser }: any) {
  const { t } = useTranslation(db);
  const activeCompany = db.companies?.find((c:any) => c.id === activeCompanyId);
  const currency = activeCompany?.currency || 'SAR';
  const [viewMode, setViewMode] = useState<'shifts' | 'audit'>('shifts');

  const today = new Date();
  const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const [fromDate, setFromDate] = useState(firstDayOfMonth.toISOString().split('T')[0]);
  const [toDate, setToDate] = useState(today.toISOString().split('T')[0]);

  const shifts = useMemo(() => {
    const start = new Date(fromDate);
    const end = new Date(toDate);
    end.setHours(23, 59, 59, 999);

    return (db.posShifts || []).filter((s: any) => {
      if (s.companyId !== activeCompanyId) return false;
      const shiftDate = new Date(s.startTime);
      return shiftDate >= start && shiftDate <= end;
    }).sort((a: any, b: any) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  }, [db.posShifts, fromDate, toDate, activeCompanyId]);
  
  const calculateShiftSales = (shiftId: string) => {
    const shiftInvoices = db.invoices.filter((i: any) => i.companyId === activeCompanyId && i.shiftId === shiftId && i.status !== 'Cancelled');
    const totalSales = shiftInvoices.reduce((sum: number, inv: any) => sum + (inv.amountPaid || 0), 0);
    return totalSales;
  };

  return (
    <div className="p-6 h-full overflow-auto">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold flex items-center gap-4">
          {t("Shifts & Z-Reports")}
          <div className="flex bg-slate-100 rounded-lg p-1">
            <button onClick={() => setViewMode('shifts')} className={`px-3 py-1 rounded text-xs font-bold ${viewMode === 'shifts' ? 'bg-white shadow' : ''}`}>{t("History")}</button>
            <button onClick={() => setViewMode('audit')} className={`px-3 py-1 rounded text-xs font-bold ${viewMode === 'audit' ? 'bg-white shadow' : ''}`}>{t("Shift Audit")}</button>
          </div>
        </h2>
        <div className="flex items-center gap-2">
           <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="text-sm border border-slate-200 rounded-lg p-2" />
           <span className="text-sm text-slate-500">{t("to")}</span>
           <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="text-sm border border-slate-200 rounded-lg p-2" />
        </div>
      </div>
      
      {viewMode === 'shifts' ? (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="p-4 font-bold text-slate-700">{t("Shift Time")}</th>
                <th className="p-4 font-bold text-slate-700">{t("User")}</th>
                <th className="p-4 font-bold text-slate-700">{t("Start Cash")}</th>
                <th className="p-4 font-bold text-slate-700">{t("Total Sales")}</th>
                <th className="p-4 font-bold text-slate-700">{t("Expected End")}</th>
                <th className="p-4 font-bold text-slate-700">{t("Actual End")}</th>
                <th className="p-4 font-bold text-slate-700">{t("Status")}</th>
              </tr>
            </thead>
            <tbody>
              {shifts.map((s: any) => {
                const user = db.users?.find((u: any) => u.id === s.userId);
                return (
                  <tr key={s.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="p-4 text-slate-600">
                      <div className="font-bold">{new Date(s.startTime).toLocaleString()}</div>
                      {s.endTime && <div className="text-xs text-slate-400">{t("to")} {new Date(s.endTime).toLocaleString()}</div>}
                    </td>
                    <td className="p-4 text-slate-800">{user?.username || s.userId}</td>
                    <td className="p-4 text-slate-600">{currency} {s.startCash.toFixed(2)}</td>
                    <td className="p-4 text-emerald-600 font-bold">+{currency} {calculateShiftSales(s.id).toFixed(2)}</td>
                    <td className="p-4 text-slate-600">{s.expectedCash !== undefined ? `${currency} ${s.expectedCash.toFixed(2)}` : '-'}</td>
                    <td className="p-4 text-slate-600 font-bold">{s.endCash !== undefined ? `${currency} ${s.endCash.toFixed(2)}` : '-'}</td>
                    <td className="p-4">
                      <span className={`px-2 py-1 rounded-md text-xs font-bold ${s.status === 'open' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>{t(s.status).toUpperCase()}</span>
                    </td>
                  </tr>
                );
              })}
              {shifts.length === 0 && (
                <tr><td colSpan={7} className="p-8 text-center text-slate-400">{t("No shifts recorded for selected period.")}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <h3 className="font-bold mb-4">{t("Cashier Variance Report")}</h3>
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="p-2">{t("Cashier")}</th>
                <th className="p-2">{t("Expected")}</th>
                <th className="p-2">{t("Actual")}</th>
                <th className="p-2">{t("Variance")}</th>
              </tr>
            </thead>
            <tbody>
              {shifts.filter(s => s.status === 'closed').map(s => {
                const user = db.users?.find((u: any) => u.id === s.userId);
                const variance = s.endCash - s.expectedCash;
                return (
                  <tr key={s.id} className="border-b">
                    <td className="p-2">{user?.username || s.userId}</td>
                    <td className="p-2">{currency} {s.expectedCash.toFixed(2)}</td>
                    <td className="p-2">{currency} {s.endCash.toFixed(2)}</td>
                    <td className={`p-2 font-bold ${variance < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                      {currency} {variance.toFixed(2)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

