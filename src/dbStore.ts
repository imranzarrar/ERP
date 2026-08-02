import {
  User,
  CompanySetup,
  DocumentTemplate,
  TaxSlab,
  ProductService,
  Customer,
  Vendor,
  BankAccount,
  FiscalMonth,
  Quotation,
  Invoice,
  InvoiceItem,
  Expense,
  RecurringExpenseTemplate,
  RecurringPosting,
  Voucher,
  TranslationItem,
  BankLedgerEntry,
  Investor,
  PosShift,
  PosHeldInvoice,
  normalizePermissions,
  Warehouse,
  PurchaseRequisition,
  PurchaseOrder,
  GoodsReceiptNote,
  InventoryStock,
  ProductCategory,
  UnitOfMeasure,
  ProductWarehouse,
  Role,
  UserRoleAssignment
} from './types';
import { generateId } from './id';
export { generateId };

export interface DatabaseState {
  companies: CompanySetup[];
  selectedCompanyId: string;
  users: User[];
  roles?: Role[];
  userRoles?: UserRoleAssignment[];
  currentUser: User;
  companySetup: CompanySetup;
  templates: DocumentTemplate[];
  taxSlabs: TaxSlab[];
  products: ProductService[];
  customers: Customer[];
  vendors: Vendor[];
  banks: BankAccount[];
  months: FiscalMonth[];
  quotations: Quotation[];
  invoices: Invoice[];
  expenses: Expense[];
  recurringTemplates: RecurringExpenseTemplate[];
  recurringPostings: RecurringPosting[];
  vouchers: Voucher[];
  translations: TranslationItem[];
  investors: Investor[];
  posShifts: PosShift[];
  posHeldInvoices: PosHeldInvoice[];
  warehouses?: Warehouse[];
  purchaseRequisitions?: PurchaseRequisition[];
  purchaseOrders?: PurchaseOrder[];
  goodsReceiptNotes?: GoodsReceiptNote[];
  inventoryStocks?: InventoryStock[];
  productCategories?: ProductCategory[];
  unitsOfMeasure?: UnitOfMeasure[];
  productWarehouses?: ProductWarehouse[];
  counters: {
    quotation: number;
    invoice: number;
    expense: number;
    voucher: number;
  };
}

// Helper to generate IDs

// Seed Companies
export const SEED_COMPANIES: CompanySetup[] = [
  {
    id: '019fa55c-622a-7cd5-b949-e61689455b41',
    name: 'CNC Woodcraft & Design',
    address: 'Bldg 45, Industrial Zone Phase 2, Riyadh 11564, Saudi Arabia',
    phone: '+966 50 123 4567',
    email: 'info@cncwoodcraft.sa',
    logoUrl: '',
    customHeader: 'Premium Wood CNC Milling, Engraving, & Fabrication Services',
    customFooter: 'Thank you for choosing CNC Woodcraft! Warranty covers 1-year structure. Terms and conditions apply.',
    vatNumber: '300123456700003',
    themeId: 'classic-executive',
    currency: 'SAR',
    portalTitle: 'CNC FAB PORTAL',
    portalSubtitle: 'Shop ERP System',
    counters: { quotation: 1001, invoice: 1001, expense: 1001, voucher: 1001 },
    isInventoryModuleEnabled: false,
    inventorySettings: { prOptionality: 'OPTIONAL', isDsdAllowed: true }
  },
  {
    id: '019fa55c-622a-736c-ba38-beb9f2291fe3',
    name: 'Naqsh Co- CNC',
    address: 'Old Saneya, Opposite Shirka Nabeel Riyadh',
    phone: '+966 52 987 6543',
    email: 'naqshco.ksa@gmail.com',
    logoUrl: '',
    customHeader: 'We deal in 3D, 3D designs, Engraving and interior wood decoration !!!',
    customFooter: 'High quality, professional skills, customer satisfaction.',
    vatNumber: '310987654300003',
    themeId: 'steel-tech',
    currency: 'SAR',
    portalTitle: 'Manufacturing ERP',
    portalSubtitle: 'ERP',
    counters: { quotation: 1001, invoice: 1018, expense: 1018, voucher: 1038 },
    isInventoryModuleEnabled: false,
    inventorySettings: { prOptionality: 'OPTIONAL', isDsdAllowed: true }
  }
];

// Seed data
export const SEED_USERS: User[] = [
  { 
    id: '019fa55c-622a-78d7-8a94-1bcf49434b9b', username: 'imranz', password: '123456', role: 'admin', isSuperAdmin: true, companyId: '019fa55c-622a-736c-ba38-beb9f2291fe3',
    permissions: { 
      sales: { quotation: { enabled: true }, invoice: { enabled: true }, cancel: { enabled: true } },
      pos: { terminal: { enabled: true }, shifts: { enabled: true }, history: { enabled: true } },
      inventory: { viewCustomers: { enabled: true }, editCustomers: { enabled: true }, viewVendors: { enabled: true }, editVendors: { enabled: true }, viewProducts: { enabled: true }, editProducts: { enabled: true } },
      expense: { expense: { enabled: true } }
    } 
  },
  { 
    id: '019fa55c-622a-7697-b7c7-b54d3bab0e2d', username: 'Staff Fatima (All Perms)', password: '123456', role: 'user', companyId: '019fa55c-622a-7cd5-b949-e61689455b41',
    permissions: { 
      sales: { quotation: { enabled: true }, invoice: { enabled: true }, cancel: { enabled: false } },
      pos: { terminal: { enabled: true }, shifts: { enabled: true }, history: { enabled: true } },
      inventory: { viewCustomers: { enabled: true }, editCustomers: { enabled: true }, viewVendors: { enabled: true }, editVendors: { enabled: true }, viewProducts: { enabled: true }, editProducts: { enabled: true } },
      expense: { expense: { enabled: true } }
    } 
  },
  { 
    id: '019fa55c-622a-79de-bfb2-2d7984ae663b', username: 'Sales Rep Tariq', password: '123456', role: 'user', companyId: '019fa55c-622a-7cd5-b949-e61689455b41',
    permissions: { 
      sales: { quotation: { enabled: true }, invoice: { enabled: true }, cancel: { enabled: false } },
      pos: { terminal: { enabled: false }, shifts: { enabled: false }, history: { enabled: false } },
      inventory: { viewCustomers: { enabled: true }, editCustomers: { enabled: true }, viewVendors: { enabled: false }, editVendors: { enabled: false }, viewProducts: { enabled: true }, editProducts: { enabled: false } },
      expense: { expense: { enabled: false } }
    } 
  },
  { 
    id: '019fa55c-622a-7a1b-8a98-1984c25a1680', username: 'Procurement Specialist Khalid', password: '123456', role: 'user', companyId: '019fa55c-622a-736c-ba38-beb9f2291fe3',
    permissions: { 
      sales: { quotation: { enabled: false }, invoice: { enabled: false }, cancel: { enabled: false } },
      pos: { terminal: { enabled: false }, shifts: { enabled: false }, history: { enabled: false } },
      inventory: { viewCustomers: { enabled: false }, editCustomers: { enabled: false }, viewVendors: { enabled: true }, editVendors: { enabled: true }, viewProducts: { enabled: true }, editProducts: { enabled: true } },
      expense: { expense: { enabled: true } }
    } 
  },
  { 
    id: '019fa55c-622a-7a28-9ad2-83013a39e58d', username: 'Supervisor Sarah (with Cancel)', password: '123456', role: 'user', companyId: '019fa55c-622a-736c-ba38-beb9f2291fe3',
    permissions: { 
      sales: { quotation: { enabled: true }, invoice: { enabled: true }, cancel: { enabled: true } },
      pos: { terminal: { enabled: true }, shifts: { enabled: true }, history: { enabled: true } },
      inventory: { viewCustomers: { enabled: true }, editCustomers: { enabled: false }, viewVendors: { enabled: true }, editVendors: { enabled: false }, viewProducts: { enabled: true }, editProducts: { enabled: false } },
      expense: { expense: { enabled: true } }
    } 
  }
];

export const SEED_COMPANY = SEED_COMPANIES[0];

export const SEED_TEMPLATES: DocumentTemplate[] = [
  { id: '019fa55c-622a-7b79-8d12-6db974e9187c', name: 'Standard English (A4 - LTR)', language: 'English', pageSize: '8.27in x 11.69in (A4)', isActive: true, printHeader: true, printFooter: true, printLogo: true, printQrCode: true, companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '019fa55c-622a-7d8c-afe9-0084b8f2c15c', name: 'Arabic Traditional (RTL)', language: 'Arabic', pageSize: '8.27in x 11.69in (A4)', isActive: false, printHeader: true, printFooter: true, printLogo: true, printQrCode: true, companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '019fa55c-622a-79e6-8e82-e186a69bfdb6', name: 'English Receipt (4in x 6in - LTR)', language: 'English', pageSize: '4in x 6in', isActive: false, printHeader: true, printFooter: true, printLogo: false, printQrCode: true, companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '019fa55c-622a-71af-89f7-698dc9a93cf2', name: 'Classic Corporate (Navy - LTR)', language: 'English', pageSize: '8.27in x 11.69in (A4)', isActive: false, printHeader: true, printFooter: true, printLogo: true, printQrCode: true, companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '019fa55c-622a-782a-af5e-131c38c6c6f9', name: 'Sleek Modern (Charcoal - LTR)', language: 'English', pageSize: '8.27in x 11.69in (A4)', isActive: false, printHeader: true, printFooter: true, printLogo: true, printQrCode: true, companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '019fa55c-622a-7938-bae0-0c8125474cd6', name: 'Standard LaserCut English (A4)', language: 'English', pageSize: '8.27in x 11.69in (A4)', isActive: true, printHeader: true, printFooter: true, printLogo: true, printQrCode: true, companyId: '019fa55c-622a-736c-ba38-beb9f2291fe3' }
];

export const SEED_TAX_SLABS: TaxSlab[] = [
  { id: '019fa55c-622a-756c-aef4-50a365dc26da', name: 'Exempt (0%)', percentage: 0 },
  { id: '019fa55c-622a-786c-abef-db3c023c269d', name: 'VAT (15%)', percentage: 15 },
  { id: '019fa55c-622a-75fb-b6dd-cd713c812efb', name: 'Reduced (5%)', percentage: 5 }
];

export const SEED_PRODUCTS: ProductService[] = [
  // Sales items
  { id: '019fa55c-622a-7bbb-a6f4-545c4ed3b356', name: 'MDF 18mm CNC Custom Cutting', description: 'Precision CNC cutting of 18mm MDF sheet per board including setups', unitPrice: 120.00, type: 'Sales', unit: 'No', companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '019fa55c-622a-77b2-a450-09039d9e5db0', name: 'Oak Wood 3D Engraving Service', description: 'Advanced 3D relief engraving per square meter', unitPrice: 350.00, type: 'Sales', unit: 'Lumpsum', companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '019fa55c-622a-7047-8e62-f1a64346efa8', name: 'Cabinet Joint Finger Joint Milling', description: 'Custom CNC finger jointing service for kitchen cabinets per unit', unitPrice: 45.00, type: 'Sales', unit: 'No', companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '019fa55c-622a-7769-a719-89c739ba62ab', name: 'Acrylic Mesh Work fabrication', description: 'Delicate pattern cutting on 5mm acrylic mesh screens per meter', unitPrice: 90.00, type: 'Sales', unit: 'Lumpsum', companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  // Purchase items
  { id: '019fa55c-622a-7d4d-b914-4eaedf1dae86', name: 'Solid Oak Timber Board 2.4m', description: 'Imported European red oak solid boards', unitPrice: 180.00, type: 'Purchase', unit: 'No', companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '019fa55c-622a-73cc-93f5-1c2b70fc6ea3', name: 'MDF Sheet 1220x2440x18mm', description: 'Raw MDF sheet 18mm thickness', unitPrice: 32.50, type: 'Purchase', unit: 'No', companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '019fa55c-622a-7cb8-b26a-00888d4fd32b', name: 'Carbide CNC Router Bits 6mm', description: 'Industrial grade solid carbide spiral flute upcut bits', unitPrice: 15.00, type: 'Purchase', unit: 'No', companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '019fa55c-622a-7742-94ae-23b45ebec8e5', name: 'Wood Adhesive Glue 5kg', description: 'High-strength waterproof PVA adhesive', unitPrice: 28.00, type: 'Purchase', unit: 'Lumpsum', companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  // LaserCut Sales
  { id: '019fa55c-622a-78f2-81cc-78ac17bed898', name: 'Laser Cut 5mm Acrylic Sheet', description: 'Precision laser cutting of acrylic sheets per hour', unitPrice: 150.00, type: 'Sales', unit: 'No', companyId: '019fa55c-622a-736c-ba38-beb9f2291fe3' },
  { id: '019fa55c-622a-7ee7-abab-57f687029517', name: 'Polishing & Finishing', description: 'Flame polishing service for flawless acrylic edges', unitPrice: 50.00, type: 'Sales', unit: 'Lumpsum', companyId: '019fa55c-622a-736c-ba38-beb9f2291fe3' },
  // LaserCut Purchases
  { id: '019fa55c-622a-7875-b0e2-00e45135a736', name: 'Raw 5mm Cast Acrylic Sheet', description: 'Cast transparent acrylic sheets 1.2m x 2.4m', unitPrice: 45.00, type: 'Purchase', unit: 'No', companyId: '019fa55c-622a-736c-ba38-beb9f2291fe3' },
  { id: '019fa55c-622a-7586-8cdb-6843929c3ecc', name: 'Laser Tube Gas Refill', description: 'Industrial CO2 laser tube recharging service', unitPrice: 120.00, type: 'Purchase', unit: 'Lumpsum', companyId: '019fa55c-622a-736c-ba38-beb9f2291fe3' }
];

export const SEED_CUSTOMERS: Customer[] = [
  { id: '019fa55c-622a-7200-a9d7-61e00a1e18f5', name: 'Walk-in Customer', phone: '-', email: '-', address: '-', isSystem: true, companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '019fa55c-622a-7c44-9694-435719cb7248', name: 'Sultan Al-Ahmad Designs', phone: '+966 55 987 6543', email: 'sultan@ahmaddesign.com', address: 'Olaya District, Riyadh', companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '019fa55c-622a-79e0-a37a-e312558e1b86', name: 'Riyadh Modern Furniture Factory', phone: '+966 11 444 5555', email: 'procure@rmff.com.sa', address: 'Second Industrial City, Riyadh', companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  // LaserCut Customers
  { id: '019fa55c-622a-7302-a025-6b0ca6301305', name: 'Walk-in Customer (Laser)', phone: '-', email: '-', address: '-', isSystem: true, companyId: '019fa55c-622a-736c-ba38-beb9f2291fe3' },
  { id: '019fa55c-622a-7fe7-bb17-c7708e9aad08', name: 'Jeddah Signage Group', phone: '+966 54 888 7777', email: 'info@jeddahsigns.sa', address: 'Madinah Road, Jeddah', companyId: '019fa55c-622a-736c-ba38-beb9f2291fe3' },
  { id: '019fa55c-622a-7d3e-98d7-402acfa7efe2', name: 'Red Sea Exhibitions', phone: '+966 12 333 4444', email: 'exhibits@redsea.com', address: 'Corniche Area, Jeddah', companyId: '019fa55c-622a-736c-ba38-beb9f2291fe3' }
];

export const SEED_VENDORS: Vendor[] = [
  { id: '019fa55c-622a-7b68-a3ca-48b3d791d521', name: 'Cash Vendor', phone: '-', email: '-', address: '-', isSystem: true, companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '019fa55c-622a-711d-a548-0db5506d2213', name: 'Gulf Wood & Timber Suppliers', phone: '+966 13 888 9999', email: 'sales@gulfwood.com', address: 'Dammam Port Area', companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '019fa55c-622a-7b8d-9bdf-dcbc1fceae6b', name: 'Al-Khobar CNC Toolings Co', phone: '+966 50 555 1212', email: 'orders@khobarcnc.sa', address: 'Al-Khobar', companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  // LaserCut Vendors
  { id: '019fa55c-622a-7b4f-a58b-519bb2986564', name: 'Cash Vendor (Laser)', phone: '-', email: '-', address: '-', isSystem: true, companyId: '019fa55c-622a-736c-ba38-beb9f2291fe3' },
  { id: '019fa55c-622a-79c8-9a8d-a115c085fe86', name: 'SABIC Acrylic Sheets', phone: '+966 11 222 3333', email: 'acrylics@sabic.com', address: 'Jubail Industrial City', companyId: '019fa55c-622a-736c-ba38-beb9f2291fe3' },
  { id: '019fa55c-622a-7c53-aa93-a247005629a7', name: 'Jeddah Precision Lasers', phone: '+966 50 777 8888', email: 'tech@jeddahlasers.sa', address: 'Al-Safa, Jeddah', companyId: '019fa55c-622a-736c-ba38-beb9f2291fe3' }
];

export const SEED_BANKS: BankAccount[] = [
  { id: '019fa55c-622a-74a3-a003-f03cb840cc67', bankName: 'Riyad Bank', accountNumber: 'SA4520000102030405060701', accountTitle: 'CNC Woodcraft Riyadh Branch', openingBalance: 12500.00, isActive: true, isDefault: true, companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '019fa55c-622a-7910-b347-e2342128e665', bankName: 'Al Rajhi Bank', accountNumber: 'SA8080000493827164928102', accountTitle: 'CNC Woodcraft Corporate Account', openingBalance: 5000.00, isActive: true, isDefault: false, companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '019fa55c-622a-75b4-9d41-49a6808446f8', bankName: 'Saudi National Bank (SNB)', accountNumber: 'SA1030000948372615493021', accountTitle: 'CNC Woodcraft Operations Account', openingBalance: 0.00, isActive: false, isDefault: false, companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  // LaserCut Banks
  { id: '019fa55c-622a-7ec8-a01a-833c62e08100', bankName: 'SABB HSBC', accountNumber: 'SA9030000847392019483726', accountTitle: 'LaserCut Operating Account', openingBalance: 8000.00, isActive: true, isDefault: true, companyId: '019fa55c-622a-736c-ba38-beb9f2291fe3' },
  { id: '019fa55c-622a-70de-84df-7f584d89703d', bankName: 'Saudi National Bank (SNB USD)', accountNumber: 'SA1234000029384756102938', accountTitle: 'LaserCut USD Reserves Account', openingBalance: 3000.00, isActive: true, isDefault: false, companyId: '019fa55c-622a-736c-ba38-beb9f2291fe3' }
];

export const SEED_MONTHS: FiscalMonth[] = [
  { id: '2026-05', name: 'May 2026', status: 'Closed', closedAt: '2026-05-31T18:00:00Z', closedOption: 'paid_only', closedPnL: { totalRevenue: 14800.00, totalExpenses: 8900.00, netProfit: 5900.00 }, companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '2026-06', name: 'June 2026', status: 'Open', companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  // LaserCut Month
  { id: '2026-06', name: 'June 2026', status: 'Open', companyId: '019fa55c-622a-736c-ba38-beb9f2291fe3' }
];

export const SEED_RECURRING: RecurringExpenseTemplate[] = [
  { id: '019fa55c-622a-7608-abff-73a3a9831c3a', description: 'Monthly CNC Workshop Space Rent', vendorId: '019fa55c-622a-7b68-a3ca-48b3d791d521', defaultAmount: 2500.00, taxSlabId: '019fa55c-622a-756c-aef4-50a365dc26da', isActive: true, bankId: '019fa55c-622a-74a3-a003-f03cb840cc67', companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '019fa55c-622a-7f13-9c66-c8ea44bf032e', description: 'Factory High-Voltage Power Utility Bill', vendorId: '019fa55c-622a-7b68-a3ca-48b3d791d521', defaultAmount: 650.00, taxSlabId: '019fa55c-622a-786c-abef-db3c023c269d', isActive: true, bankId: '019fa55c-622a-74a3-a003-f03cb840cc67', companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '019fa55c-622a-7685-9515-850c8efc8a54', description: 'Workshop Supervisor Salary Pool', vendorId: '019fa55c-622a-7b68-a3ca-48b3d791d521', defaultAmount: 4500.00, taxSlabId: '019fa55c-622a-756c-aef4-50a365dc26da', isActive: true, bankId: '019fa55c-622a-7910-b347-e2342128e665', companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  { id: '019fa55c-622a-77af-b51d-11d291da590d', description: 'Fusion 360 CNC CAD Software Subscription', vendorId: '019fa55c-622a-7b8d-9bdf-dcbc1fceae6b', defaultAmount: 180.00, taxSlabId: '019fa55c-622a-786c-abef-db3c023c269d', isActive: false, bankId: '019fa55c-622a-7910-b347-e2342128e665', companyId: '019fa55c-622a-7cd5-b949-e61689455b41' },
  // LaserCut Recurring templates
  { id: '019fa55c-622a-7ad6-a956-46f88dec14ea', description: 'Jeddah Laser Workshop Lease', vendorId: '019fa55c-622a-7b4f-a58b-519bb2986564', defaultAmount: 1800.00, taxSlabId: '019fa55c-622a-756c-aef4-50a365dc26da', isActive: true, bankId: '019fa55c-622a-7ec8-a01a-833c62e08100', companyId: '019fa55c-622a-736c-ba38-beb9f2291fe3' },
  { id: '019fa55c-622a-79d8-9d9b-dd245beaf6db', description: 'High Power Laser Utilities', vendorId: '019fa55c-622a-7b4f-a58b-519bb2986564', defaultAmount: 450.00, taxSlabId: '019fa55c-622a-786c-abef-db3c023c269d', isActive: true, bankId: '019fa55c-622a-7ec8-a01a-833c62e08100', companyId: '019fa55c-622a-736c-ba38-beb9f2291fe3' }
];


export const SEED_TRANSLATIONS: TranslationItem[] = [
  { id: '019fa55c-622a-70f7-9839-3eb7b72ed284', key: 'Operations & Commerce', en: 'Operations & Commerce', ar: 'العمليات والتجارة', ur: 'آپریشنز اور تجارت' },
  { id: '019fa55c-622a-7d38-9c51-752bb7ae31f7', key: 'Command Center', en: 'Command Center', ar: 'مركز القيادة', ur: 'کمانڈ سنٹر' },
  { id: '019fa55c-622a-7acc-ac2c-049aebefd8c6', key: 'Quotation Book', en: 'Quotation Book', ar: 'دفتر عروض الأسعار', ur: 'اقتباسات کی کتاب' },
  { id: '019fa55c-622a-7594-b66b-a9323ccf52a8', key: 'Sales Invoices', en: 'Sales Invoices', ar: 'فواتير المبيعات', ur: 'فروخت کی رسیدیں' },
  { id: '019fa55c-622a-731c-826e-003d0ada7b1a', key: 'Procurements', en: 'Procurements', ar: 'المشتريات', ur: 'خریداری' },
  { id: '019fa55c-622a-77b7-9292-6e5c9da3d155', key: 'Recurring & Accruals', en: 'Recurring & Accruals', ar: 'المتكررة والمستحقات', ur: 'بار بار اور واجب الادا' },
  { id: '019fa55c-622a-77da-b67e-8da5f2a3203c', key: 'Master Registries', en: 'Master Registries', ar: 'السجلات الرئيسية', ur: 'ماسٹر رجسٹریاں' },
  { id: '019fa55c-622a-72dc-bcb8-71bc0ddb125d', key: 'Customers CRM', en: 'Customers CRM', ar: 'إدارة العملاء', ur: 'کسٹمرز سی آر ایم' },
  { id: '019fa55c-622a-767a-88e3-f16bb9b4457d', key: 'Vendors Directory', en: 'Vendors Directory', ar: 'دليل الموردين', ur: 'سپلائرز ڈائرکٹری' },
  { id: '019fa55c-622a-7f32-96e5-d98835cc3655', key: 'Products & Pricing', en: 'Products & Pricing', ar: 'المنتجات والأسعار', ur: 'مصنوعات اور قیمتیں' },
  { id: '019fa55c-622a-7e15-bd15-85ae1beca274', key: 'Intelligence & Reports', en: 'Intelligence & Reports', ar: 'التقارير والتحليلات', ur: 'رپورٹس اور تجزیہ' },
  { id: '019fa55c-622a-7112-b2f8-8199e2cc0630', key: 'Financial Reports', en: 'Financial Reports', ar: 'التقارير المالية', ur: 'مالیاتی رپورٹس' },
  { id: '019fa55c-622a-723a-8a52-85e9a1a680e2', key: 'Setup & Governance', en: 'Setup & Governance', ar: 'الإعدادات والحوكمة', ur: 'سیٹ اپ اور گورننس' },
  { id: '019fa55c-622a-7c2e-854a-e71b9d059bb3', key: 'Settings & Companies', en: 'Settings & Companies', ar: 'الإعدادات والشركات', ur: 'ترتیبات اور کمپنیاں' },
  { id: '019fa55c-622a-7c90-b431-6bf175cc663e', key: 'Draft & Issue Sales Invoice', en: 'Draft & Issue Sales Invoice', ar: 'إصدار فاتورة مبيعات', ur: 'فروخت کی انوائس جاری کریں' },
  { id: '019fa55c-622a-7946-ba6d-b2c9ac5519f8', key: 'Draft & Issue Quotation', en: 'Draft & Issue Quotation', ar: 'إصدار عرض سعر', ur: 'اقتباس جاری کریں' },
  { id: '019fa55c-622a-71ca-88c2-3941c78a408d', key: 'Log Procurement / Tooling Expense', en: 'Log Procurement / Tooling Expense', ar: 'تسجيل المصاريف / الأدوات', ur: 'اخراجات / ٹولنگ درج کریں' },
  { id: '019fa55c-622a-7722-b93b-1fff0908d55c', key: 'UX Translations Dictionary', en: 'UX Translations Dictionary', ar: 'قاموس الترجمات', ur: 'ترجمہ ڈکشنری' },
  { id: '019fa55c-622a-7dbc-9bd6-491b01f169ee', key: 'Draft New Fabrication Quotation', en: 'Draft New Fabrication Quotation', ar: 'مسودة عرض أسعار جديد', ur: 'نئے اقتباس کا مسودہ تیار کریں' },
  { id: '019fa55c-622a-7184-a4ee-a097c68cb610', key: 'Modify Existing Quotation', en: 'Modify Existing Quotation', ar: 'تعديل عرض سعر حالي', ur: 'موجودہ اقتباس میں ترمیم کریں' },
  { id: '019fa55c-622a-71f1-8f4e-88eb7fac63f2', key: 'Administrative Portal', en: 'Administrative Portal', ar: 'بوابة الإدارة', ur: 'انتظامی پورٹل' },
  { id: '019fa55c-622a-7080-bdcc-621b1148bb4a', key: 'Staff Fabrication Workshop', en: 'Staff Fabrication Workshop', ar: 'ورشة تصنيع الموظفين', ur: 'اسٹاف فیبریکیشن ورکشاپ' }
,
{ id: '019fa55c-622a-739d-91eb-0c81dc711c7b', key: 'Welcome back, ', en: 'Welcome back, ', ar: 'مرحباً بعودتك، ', ur: 'خوش آمدید، ' },
  { id: '019fa55c-622a-75c0-a7ac-3731299f419d', key: 'Active Session Month:', en: 'Active Session Month:', ar: 'شهر الجلسة النشطة:', ur: 'فعال سیشن کا مہینہ:' },
  { id: '019fa55c-622a-7b1c-be2a-9f712d6ff4e7', key: 'None Open', en: 'None Open', ar: 'لا يوجد مفتوح', ur: 'کوئی کھلا نہیں' },
  { id: '019fa55c-622a-730d-837b-388a0a1accd2', key: 'Active Quotations Book', en: 'Active Quotations Book', ar: 'دفتر عروض الأسعار النشطة', ur: 'فعال کوٹیشن بک' },
  { id: '019fa55c-622a-792a-b146-dcf95895e6ff', key: 'Customize & Convert Accepted Quotation', en: 'Customize & Convert Accepted Quotation', ar: 'تخصيص وتحويل عرض السعر المقبول', ur: 'قبول شدہ کوٹیشن کو اپنی مرضی کے مطابق بنائیں اور تبدیل کریں' },
  { id: '019fa55c-622a-72c6-9ce3-42179183565b', key: 'Active Invoices Book', en: 'Active Invoices Book', ar: 'دفتر الفواتير النشطة', ur: 'فعال انوائس بک' },
  { id: '019fa55c-622a-7e3c-b2cb-834fe2b377bb', key: 'Receive Invoice Payment', en: 'Receive Invoice Payment', ar: 'استلام دفعة الفاتورة', ur: 'انوائس کی ادائیگی وصول کریں' },
  { id: '019fa55c-622a-77f4-acd3-7263fb8e58e3', key: 'Recorded Expenses & Assets', en: 'Recorded Expenses & Assets', ar: 'المصاريف والأصول المسجلة', ur: 'ریکارڈ شدہ اخراجات اور اثاثے' },
  { id: '019fa55c-622a-7b5f-a8a4-e6af1aca9fe0', key: 'Create New Customer', en: 'Create New Customer', ar: 'إنشاء عميل جديد', ur: 'نیا کسٹمر بنائیں' },
  { id: '019fa55c-622a-719e-864f-5fa58d42c904', key: 'Manage Customers', en: 'Manage Customers', ar: 'إدارة العملاء', ur: 'کسٹمرز کا نظم کریں' },
  { id: '019fa55c-622a-7c8e-8e0d-166425eb711a', key: 'Create New Vendor', en: 'Create New Vendor', ar: 'إنشاء مورد جديد', ur: 'نیا وینڈر بنائیں' },
  { id: '019fa55c-622a-7e1b-a44f-a2ea5c08e33c', key: 'Manage Vendors', en: 'Manage Vendors', ar: 'إدارة الموردين', ur: 'وینڈرز کا نظم کریں' },
  { id: '019fa55c-622a-719d-9f70-6a2e7b4b1245', key: 'Create New Product', en: 'Create New Product', ar: 'إنشاء منتج جديد', ur: 'نئی پروڈکٹ بنائیں' },
  { id: '019fa55c-622a-743a-8192-338c1e75c85e', key: 'Manage Products', en: 'Manage Products', ar: 'إدارة المنتجات', ur: 'مصنوعات کا نظم کریں' },
  { id: '019fa55c-622a-7421-b8ee-38b3ccf62b45', key: 'Current Period Status', en: 'Current Period Status', ar: 'حالة الفترة الحالية', ur: 'موجودہ مدت کی حیثیت' },
  { id: '019fa55c-622a-718c-b2ed-6220ceb0e3df', key: 'Edit Recurring Template', en: 'Edit Recurring Template', ar: 'تعديل قالب متكرر', ur: 'بار بار ٹیمپلیٹ میں ترمیم کریں' },
  { id: '019fa55c-622a-7dab-8954-e5546da8149e', key: 'Add New Recurring Template', en: 'Add New Recurring Template', ar: 'إضافة قالب متكرر جديد', ur: 'نیا بار بار ٹیمپلیٹ شامل کریں' },
  { id: '019fa55c-622a-710b-8897-93aeeb7796e5', key: 'Edit Accrual Ledger Entry', en: 'Edit Accrual Ledger Entry', ar: 'تعديل إدخال دفتر الاستحقاق', ur: 'اکروول لیجر انٹری میں ترمیم کریں' },
  { id: '019fa55c-622a-7d4a-bcc0-a93bfa3f05b3', key: 'Post Recurring Expense', en: 'Post Recurring Expense', ar: 'ترحيل مصروف متكرر', ur: 'بار بار خرچ پوسٹ کریں' },
  { id: '019fa55c-622a-7d46-94f2-4ce4902986f4', key: 'Settle Accrual Liability', en: 'Settle Accrual Liability', ar: 'تسوية التزام الاستحقاق', ur: 'اکروول واجبات کو طے کریں' },
  { id: '019fa55c-622a-7be9-9b65-95e70f17157b', key: 'Multi-Organization & Company Profiles', en: 'Multi-Organization & Company Profiles', ar: 'ملفات تعريف المنظمات والشركات المتعددة', ur: 'ملٹی آرگنائزیشن اور کمپنی پروفائلز' },
  { id: '019fa55c-622a-7ca5-b2b0-b946cc6c7e29', key: 'Global Company Setup', en: 'Global Company Setup', ar: 'إعداد الشركة العالمية', ur: 'عالمی کمپنی سیٹ اپ' },
  { id: '019fa55c-622a-7235-b517-00c242c52d0c', key: 'Active Bank Accounts & Ledger Balances', en: 'Active Bank Accounts & Ledger Balances', ar: 'الحسابات المصرفية النشطة وأرصدة دفتر الأستاذ', ur: 'فعال بینک اکاؤنٹس اور لیجر بیلنس' },
  { id: '019fa55c-622a-7d7f-96cc-80eaf5c15f5c', key: 'Tax Slab Configuration', en: 'Tax Slab Configuration', ar: 'تكوين شريحة الضرائب', ur: 'ٹیکس سلیب کنفیگریشن' },
  { id: '019fa55c-622a-7584-9b5a-aef2572e8c66', key: 'Document Template Engine', en: 'Document Template Engine', ar: 'محرك قالب المستند', ur: 'دستاویز ٹیمپلیٹ انجن' },
  { id: '019fa55c-622a-7d99-a679-eb5821c15f32', key: 'Fiscal Calendar Management', en: 'Fiscal Calendar Management', ar: 'إدارة التقويم المالي', ur: 'مالیاتی کیلنڈر کا انتظام' },
  { id: '019fa55c-622a-7f69-8826-6c4522f75654', key: 'Staff Accounts & RBAC Permissions', en: 'Staff Accounts & RBAC Permissions', ar: 'حسابات الموظفين وأذونات RBAC', ur: 'عملے کے اکاؤنٹس اور RBAC اجازتیں' },
  { id: '019fa55c-622a-77d2-bde4-7261b8a6374a', key: 'Investor Equity & Capital Contributions', en: 'Investor Equity & Capital Contributions', ar: 'حقوق المستثمرين والمساهمات الرأسمالية', ur: 'سرمایہ کاروں کی ایکویٹی اور سرمائے کا حصہ' },
  { id: '019fa55c-622a-75ac-a845-daa2368c97be', key: 'Database Portability & Backup', en: 'Database Portability & Backup', ar: 'قابلية نقل قاعدة البيانات والنسخ الاحتياطي', ur: 'ڈیٹا بیس کی پورٹیبلٹی اور بیک اپ' },
  { id: '019fa55c-622a-7f8b-90ec-a7fcd7f4d925', key: 'Gross Month Sales', en: 'Gross Month Sales', ar: 'إجمالي مبيعات الشهر', ur: 'مجموعی ماہانہ فروخت' },
  { id: '019fa55c-622a-74a9-8dea-a86c1798b282', key: 'Gross Month Expenses', en: 'Gross Month Expenses', ar: 'إجمالي مصروفات الشهر', ur: 'مجموعی ماہانہ اخراجات' },
  { id: '019fa55c-622a-7431-9341-84a7e1cfe366', key: 'Recorded Net Profit', en: 'Recorded Net Profit', ar: 'صافي الأرباح المسجلة', ur: 'درج شدہ خالص منافع' },
  { id: '019fa55c-622a-76ce-8a41-c09caffe1b5d', key: 'Active Bank Capital', en: 'Active Bank Capital', ar: 'رأس المال المصرفي النشط', ur: 'فعال بینک سرمایہ' },
  { id: '019fa55c-622a-7b2c-8fd6-c0bb643c6c4b', key: 'Command Reporting Filter', en: 'Command Reporting Filter', ar: 'فلتر تقارير القيادة', ur: 'کمانڈ رپورٹنگ فلٹر' },
  { id: '019fa55c-622a-726c-aea2-118a7c1b47ea', key: 'All Months Combined', en: 'All Months Combined', ar: 'جميع الأشهر مجتمعة', ur: 'تمام مہینے مشترکہ' },
  { id: '019fa55c-622a-7089-bfa9-2b9f899eb6ab', key: 'Shop Standard System Time', en: 'Shop Standard System Time', ar: 'توقيت نظام الورشة القياسي', ur: 'شاپ کا معیاری نظام وقت' },
  { id: '019fa55c-622a-758e-a069-2eef2272198d', key: 'No Active Fiscal Month Detected', en: 'No Active Fiscal Month Detected', ar: 'لم يتم الكشف عن شهر مالي نشط', ur: 'کوئی فعال مالیاتی مہینہ نہیں ملا' },
  { id: '019fa55c-622a-77ee-9800-5e8ab886a544', key: 'Gross sales figure inclusive of VAT', en: 'Gross sales figure inclusive of VAT', ar: 'إجمالي المبيعات شاملاً ضريبة القيمة المضافة', ur: 'مجموعی فروخت بشمول ویٹ ٹیکس' },
  { id: '019fa55c-622a-701a-9491-802662e04e0c', key: 'Cash Received (Month)', en: 'Cash Received (Month)', ar: 'النقد المستلم (الشهر)', ur: 'وصول شدہ نقد (ماہانہ)' },
  { id: '019fa55c-622a-7bb6-8d56-5111ce3c6e2f', key: 'Cash Paid out (Month)', en: 'Cash Paid out (Month)', ar: 'النقد المدفوع (الشهر)', ur: 'ادا شدہ نقد (ماہانہ)' },
  { id: '019fa55c-622a-75a8-abd7-62d0a61d51d9', key: 'Net Margin', en: 'Net Margin', ar: 'هامش الربح الصافي', ur: 'خالص مارجن' },
  { id: '019fa55c-622a-761c-ae99-cd1db07e8a8c', key: 'Active Accounts Balance', en: 'Active Accounts Balance', ar: 'أرصدة الحسابات النشطة', ur: 'فعال اکاؤنٹس کا بیلنس' },
  { id: '019fa55c-622a-79af-88c5-9469ddf1e184', key: 'Daily Sales & Expenses Timeline', en: 'Daily Sales & Expenses Timeline', ar: 'مخطط المبيعات والمصروفات اليومية', ur: 'روزانہ فروخت اور اخراجات کی ٹائم لائن' },
  { id: '019fa55c-622a-7dd3-9041-031ff5c7629b', key: 'Sales Target Progress', en: 'Sales Target Progress', ar: 'تقدم هدف المبيعات', ur: 'فروخت کے ہدف کی پیشرفت' },
  { id: '019fa55c-622a-7341-940f-76c542c90433', key: 'Quotation Volume Target', en: 'Quotation Volume Target', ar: 'هدف حجم عروض الأسعار', ur: 'کوٹیشن کے حجم کا ہدف' },
  { id: '019fa55c-622a-794c-8110-f2fc88a3112f', key: 'Recent Quotations & Active Deals', en: 'Recent Quotations & Active Deals', ar: 'عروض الأسعار الحديثة والصفقات النشطة', ur: 'حالیہ کوٹیشنز اور فعال سودے' },
  { id: '019fa55c-622a-7775-86f6-6a1a6e9b6cbf', key: 'Recent Invoices & Receivables', en: 'Recent Invoices & Receivables', ar: 'الفواتير الحديثة والمستحقات', ur: 'حالیہ رسیدیں اور واجبات' },
  { id: '019fa55c-622a-7c76-8000-baab9c2576da', key: 'Recent Procurement Expenses', en: 'Recent Procurement Expenses', ar: 'مصروفات المشتريات الحديثة', ur: 'حالیہ خریداری کے اخراجات' },
  { id: '019fa55c-622a-7a63-95be-7b0b14b66e5e', key: 'View All', en: 'View All', ar: 'عرض الكل', ur: 'سب دیکھیں' },
  { id: '019fa55c-622a-75a2-a686-6711bbbd71b3', key: 'Draft New Quotation', en: 'Draft New Quotation', ar: 'مسودة عرض سعر جديد', ur: 'نیا کوٹیشن تیار کریں' },
  { id: '019fa55c-622a-7b97-a125-ecfea89fa2f2', key: 'Draft New Invoice', en: 'Draft New Invoice', ar: 'إصدار فاتورة جديدة', ur: 'نئی رسید تیار کریں' },
  { id: '019fa55c-622a-73d2-a614-ffa54874586b', key: 'Log New Expense', en: 'Log New Expense', ar: 'تسجيل مصروف جديد', ur: 'نیا خرچ درج کریں' },
  { id: '019fa55c-622a-785f-9e6c-0bd6d94a6e1a', key: 'Create New Template', en: 'Create New Template', ar: 'إنشاء قالب جديد', ur: 'نیا ٹیمپلیٹ بنائیں' },
  { id: '019fa55c-622a-7381-8018-beffccf7c5c7', key: 'Search quotations...', en: 'Search quotations...', ar: 'البحث في عروض الأسعار...', ur: 'کوٹیشنز تلاش کریں...' },
  { id: '019fa55c-622a-7b5b-bbd0-267715d0c880', key: 'Search invoices...', en: 'Search invoices...', ar: 'البحث في الفواتير...', ur: 'رسیدیں تلاش کریں...' },
  { id: '019fa55c-622a-7a65-acdb-9fa8bd87cbb0', key: 'Search products...', en: 'Search products...', ar: 'البحث في المنتجات...', ur: 'مصنوعات تلاش کریں...' },
  { id: '019fa55c-622a-7498-9bea-69e2716d2be9', key: 'Date', en: 'Date', ar: 'التاريخ', ur: 'تاریخ' },
  { id: '019fa55c-622a-715b-86f2-98a24be5db6a', key: 'Customer', en: 'Customer', ar: 'العميل', ur: 'کسٹمر' },
  { id: '019fa55c-622a-7b37-b5b9-e3d2049642ac', key: 'Vendor', en: 'Vendor', ar: 'المورد', ur: 'وینڈر' },
  { id: '019fa55c-622a-7733-92c5-91f038b11157', key: 'Amount', en: 'Amount', ar: 'المبلغ', ur: 'رقم' },
  { id: '019fa55c-622a-7013-be75-33bfaca7a46a', key: 'Status', en: 'Status', ar: 'الحالة', ur: 'حالت' },
  { id: '019fa55c-622a-7604-8409-e3fff85ee86d', key: 'Actions', en: 'Actions', ar: 'الإجراءات', ur: 'اقدامات' },
  { id: '019fa55c-622a-7646-84a0-cc57937172f5', key: 'Total Amount', en: 'Total Amount', ar: 'المبلغ الإجمالي', ur: 'کل رقم' },
  { id: '019fa55c-622a-71db-a366-7a209a065147', key: 'Paid Amount', en: 'Paid Amount', ar: 'المبلغ المدفوع', ur: 'ادا شدہ رقم' },
  { id: '019fa55c-622a-7773-b4da-1df9f66876e0', key: 'Due Amount', en: 'Due Amount', ar: 'المبلغ المستحق', ur: 'واجب الادا رقم' },
  { id: '019fa55c-622a-7466-8038-2efcd6768c5e', key: 'Subject', en: 'Subject', ar: 'الموضوع', ur: 'موضوع' },
  { id: '019fa55c-622a-75b5-8238-c278cd8ee974', key: 'Description', en: 'Description', ar: 'الوصف', ur: 'تفصیل' },
  { id: '019fa55c-622a-798c-a571-3d868de79df3', key: 'Type', en: 'Type', ar: 'النوع', ur: 'قسم' },
  { id: '019fa55c-622a-79fd-8065-cb693008fcdd', key: 'Save', en: 'Save', ar: 'حفظ', ur: 'محفوظ کریں' },
  { id: '019fa55c-622a-7ce5-83ef-4dc9eb32ced3', key: 'Cancel', en: 'Cancel', ar: 'إلغاء', ur: 'منسوخ کریں' },
  { id: '019fa55c-622a-7701-8053-ada2f63ed1d4', key: 'Add', en: 'Add', ar: 'إضافة', ur: 'شامل کریں' },
  { id: '019fa55c-622a-718d-bbc0-84d898cc355d', key: 'Edit', en: 'Edit', ar: 'تعديل', ur: 'ترمیم کریں' },
  { id: '019fa55c-622a-702a-9016-a7c4ddc644d7', key: 'Delete', en: 'Delete', ar: 'حذف', ur: 'حذف کریں' },
  { id: '019fa55c-622b-7541-9188-5fce91f44352', key: 'Print', en: 'Print', ar: 'طباعة', ur: 'پرنٹ کریں' },
  { id: '019fa55c-622b-712c-ad0c-bbb7077dae81', key: 'Close', en: 'Close', ar: 'إغلاق', ur: 'بند کریں' },
  { id: '019fa55c-622b-7e62-9154-6ac00d72fe34', key: 'Filter', en: 'Filter', ar: 'تصفية', ur: 'فلٹر' },
  { id: '019fa55c-622b-78cc-b197-fc982b7e4cfc', key: 'All', en: 'All', ar: 'الكل', ur: 'سب' },
  { id: '019fa55c-622b-7fae-8eb6-588d2306340a', key: 'Draft', en: 'Draft', ar: 'مسودة', ur: 'مسودہ' },
  { id: '019fa55c-622b-7de7-b6de-4b4b5aeb9493', key: 'Approved', en: 'Approved', ar: 'مقبول', ur: 'منظور شدہ' },
  { id: '019fa55c-622b-7e37-89e0-9e6049f2422e', key: 'Invoiced', en: 'Invoiced', ar: 'مفوتر', ur: 'انوائس شدہ' },
  { id: '019fa55c-622b-7101-95e8-4a7ddad39d95', key: 'Rejected', en: 'Rejected', ar: 'مرفوض', ur: 'مسترد شدہ' },
  { id: '019fa55c-622b-7cf6-9a18-6a286a409c90', key: 'Unpaid', en: 'Unpaid', ar: 'غير مدفوع', ur: 'غیر ادا شدہ' },
  { id: '019fa55c-622b-78f8-a995-2756763f1c7a', key: 'Paid', en: 'Paid', ar: 'مدفوع', ur: 'ادا شدہ' },
  { id: '019fa55c-622b-75d5-8751-26817fc4028c', key: 'Partially Paid', en: 'Partially Paid', ar: 'مدفوع جزئياً', ur: 'جزوی طور پر ادا شدہ' },
  { id: '019fa55c-622b-7f7d-a8ad-ade4efbdcf73', key: 'Overdue', en: 'Overdue', ar: 'متأخر', ur: 'واجب الادا تاریخ گزر گئی' },
  { id: '019fa55c-622b-711f-9057-c7808c20a29d', key: 'Active', en: 'Active', ar: 'نشط', ur: 'فعال' },
  { id: '019fa55c-622b-700d-a67c-1aa5bd897977', key: 'Closed', en: 'Closed', ar: 'مغلق', ur: 'بند' },
  { id: '019fa55c-622b-7e77-87fc-42574daf4bce', key: 'Open', en: 'Open', ar: 'مفتوح', ur: 'کھلا' },
  { id: '019fa55c-622b-7e6d-8707-31f653be74d3', key: 'Unposted', en: 'Unposted', ar: 'غير مرحل', ur: 'غیر پوسٹ شدہ' },
  { id: '019fa55c-622b-71a7-b36c-116e1e2f96e6', key: 'Accrual', en: 'Accrual', ar: 'استحقاق', ur: 'اکروول' },
  { id: '019fa55c-622b-739f-90de-c3ecc6a29103', key: 'Actual', en: 'Actual', ar: 'فعلي', ur: 'اصل' },
  { id: '019fa55c-622b-7c76-889a-b140bb7c35f3', key: 'Product', en: 'Product', ar: 'المنتج', ur: 'مصنوعات' },
  { id: '019fa55c-622b-723c-94bc-6d68ff3305bb', key: 'Quantity', en: 'Quantity', ar: 'الكمية', ur: 'مقدار' },
  { id: '019fa55c-622b-785e-ab2a-f5ac2f488091', key: 'Price', en: 'Price', ar: 'السعر', ur: 'قیمت' },
  { id: '019fa55c-622b-7ae3-92cc-8845e8452427', key: 'Tax', en: 'Tax', ar: 'الضريبة', ur: 'ٹیکس' },
  { id: '019fa55c-622b-77f3-8774-4f644cf1426e', key: 'Subtotal', en: 'Subtotal', ar: 'المجموع الفرعي', ur: 'ذیلی کل' },
  { id: '019fa55c-622b-77f3-ae31-d757ec78ae81', key: 'Grand Total', en: 'Grand Total', ar: 'المجموع الكلي', ur: 'کل مجموعہ' },
  { id: '019fa55c-622b-7137-9132-45919981d2a0', key: 'Add Line', en: 'Add Line', ar: 'إضافة سطر', ur: 'لائن شامل کریں' },
  { id: '019fa55c-622b-7b8a-8054-861479229516', key: 'Record Payment', en: 'Record Payment', ar: 'تسجيل دفعة', ur: 'ادائیگی درج کریں' },
  { id: '019fa55c-622b-7171-bc8d-49f4f335e5f4', key: 'Payment Status', en: 'Payment Status', ar: 'حالة الدفع', ur: 'ادائیگی کی صورتحال' },
  { id: '019fa55c-622b-79cb-bd28-1b9bc563e273', key: 'Bank Account', en: 'Bank Account', ar: 'الحساب البنكي', ur: 'بینک اکاؤنٹ' },
  { id: '019fa55c-622b-7fe9-9253-4f343175ea2f', key: 'Accrued', en: 'Accrued', ar: 'مستحق', ur: 'اکروڈ' },
  { id: '019fa55c-622b-7178-b415-eb6268c90383', key: 'Accrual Settled', en: 'Accrual Settled', ar: 'تمت تسوية الاستحقاق', ur: 'اکروول سیٹل ہو گیا' },
  { id: '019fa55c-622b-761e-9c1c-3c692d00161c', key: 'Includes VAT Tax', en: 'Includes VAT Tax', ar: 'يشمل ضريبة القيمة المضافة', ur: 'بشمول ویٹ ٹیکس' },
  { id: '019fa55c-622b-763a-85ec-cb78c4704b31', key: 'Cash Capital In Bank', en: 'Cash Capital In Bank', ar: 'رأس المال النقدي بالبنك', ur: 'بینک میں نقد سرمایہ' },
  { id: '019fa55c-622b-7e3c-a407-ae00c7cff81a', key: 'Across all active banks', en: 'Across all active banks', ar: 'عبر جميع البنوك النشطة', ur: 'تمام فعال بینکوں میں' },
  { id: '019fa55c-622b-7302-8657-a1c88a4a3eb0', key: 'Manage Capital & Equity', en: 'Manage Capital & Equity', ar: 'إدارة رأس المال وحقوق الملكية', ur: 'سرمایہ اور ایکویٹی کا نظم کریں' },
  { id: '019fa55c-622b-7a3a-9753-c5988bd53bb2', key: 'Pending Collections', en: 'Pending Collections', ar: 'التحصيلات المعلقة', ur: 'زیر التواء وصولیاں' },
  { id: '019fa55c-622b-7a77-8c03-3301c5eb01f9', key: 'On account sales credit', en: 'On account sales credit', ar: 'على الحساب الائتماني للمبيعات', ur: 'فروخت کے ادھار کھاتے پر' },
  { id: '019fa55c-622b-7339-b1c9-2d8a59b414b1', key: 'Actual cash outflow expenses', en: 'Actual cash outflow expenses', ar: 'المصاريف النقدية الفعلية الخارجة', ur: 'حقیقی نقد اخراجات' },
  { id: '019fa55c-622b-7c11-ba1d-2688817fa6fc', key: 'Incurred / Accruals (Month)', en: 'Incurred / Accruals (Month)', ar: 'المتكبدة / المستحقات (الشهر)', ur: 'اٹھائے گئے / واجب الادا اخراجات (ماہانہ)' },
  { id: '019fa55c-622b-75ec-a1ff-01adf07741ce', key: 'No Active Fiscal Month Warning Text', en: 'There is currently no open fiscal month for this company. Please go to Settings > Fiscal Months to open a month so that transactions can be processed and verified correctly.', ar: 'لا يوجد شهر مالي مفتوح حاليًا لهذه الشركة. يرجى الذهاب إلى الإعدادات > الأشهر المالية لفتح شهر حتى يمكن معالجة المعاملات والتحقق منها بشكل صحيح.', ur: 'اس کمپنی کے لئے فی الحال کوئی کھلا مالیاتی مہینہ نہیں ہے۔ براہ کرم ترتیبات > مالیاتی مہینے میں جا کر مہینہ کھولیں تاکہ لین دین کی صحیح طریقے سے جانچ کی جا سکے۔' },
  { id: '019fa55c-622b-760d-bdad-5c1aacb951bd', key: 'Open Fiscal Month Setting', en: 'Open Fiscal Month Setting', ar: 'إعداد فتح الشهر المالي', ur: 'کھولیں مالیاتی مہینے کی ترتیب' },
  { id: '019fa55c-622b-756e-a307-e97365125258', key: 'Submitting for:', en: 'Submitting for:', ar: 'تقديم لـ:', ur: 'کے لئے جمع کروا رہے ہیں:' },
  { id: '019fa55c-622b-7431-a3a4-a45d6f3a8310', key: 'Back to List', en: 'Back to List', ar: 'العودة إلى القائمة', ur: 'فہرست پر واپس جائیں' },
  { id: '019fa55c-622b-7e05-8b34-4b8eafc4ba7c', key: 'Invoice Date', en: 'Invoice Date', ar: 'تاريخ الفاتورة', ur: 'رسید کی تاریخ' },
  { id: '019fa55c-622b-727e-8c2d-3cae26014103', key: 'Post Inflow Bank', en: 'Post Inflow Bank', ar: 'بنك ترحيل المقبوضات', ur: 'رقم وصول کرنے والا بینک' },
  { id: '019fa55c-622b-7182-b782-d27fe2d007ee', key: 'Invoice Payment Status', en: 'Invoice Payment Status', ar: 'حالة دفع الفاتورة', ur: 'انوائس کی ادائیگی کی حالت' },
  { id: '019fa55c-622b-720a-972e-8955d821e745', key: 'Paid (Generates Receipt Voucher instantly)', en: 'Paid (Generates Receipt Voucher instantly)', ar: 'مدفوع (يصدر سند قبض فوراً)', ur: 'ادا شدہ (فوری طور پر رسید واؤچر بناتا ہے)' },
  { id: '019fa55c-622b-78ef-b5bc-79ce82926248', key: 'Pending / On Account Credit', en: 'Pending / On Account Credit', ar: 'معلق / على الحساب الائتماني', ur: 'زیر التواء / ادھار کھاتہ' },
  { id: '019fa55c-622b-7efa-82f3-aa549b3f2fec', key: 'Design File (Attachment)', en: 'Design File (Attachment)', ar: 'ملف التصميم (مرفق)', ur: 'ڈیزائن فائل (منسلکہ)' },
  { id: '019fa55c-622b-7d4b-8d42-1fb86ef8ae13', key: 'Notes / Memo', en: 'Notes / Memo', ar: 'ملاحظات / مذكرة', ur: 'نوٹ / میمو' },
  { id: '019fa55c-622b-7f77-8ca3-c426f08f608b', key: 'Header Discount %', en: 'Header Discount %', ar: 'خصم رأس الفاتورة %', ur: 'انوائس ڈسکاؤنٹ فیصد %' },
  { id: '019fa55c-622b-7bf7-8523-5ddb93e0b000', key: 'Itemised Fabrication Line Items', en: 'Itemised Fabrication Line Items', ar: 'بنود التصنيع المفصلة', ur: 'تفصیلی فیبریکیشن اشیاء' },
  { id: '019fa55c-622b-725c-a135-5194c337e63a', key: 'Item Description / Catalogue Search', en: 'Item Description / Catalogue Search', ar: 'وصف البند / البحث في الكتالوج', ur: 'آئٹم کی تفصیل / کیٹلاگ تلاش' },
  { id: '019fa55c-622b-7152-a8e9-dd7459e84fce', key: 'Add Fabrication Line', en: 'Add Fabrication Line', ar: 'إضافة سطر تصنيع', ur: 'فیبریکیشن لائن شامل کریں' },
  { id: '019fa55c-622b-75de-b1de-069689ae5b34', key: 'Save and Issue Invoice', en: 'Save and Issue Invoice', ar: 'حفظ وإصدار الفاتورة', ur: 'انوائس محفوظ کریں اور جاری کریں' },
  { id: '019fa55c-622b-7287-a1bf-99c838094762', key: 'Document Date', en: 'Document Date', ar: 'تاريخ المستند', ur: 'دستاویز کی تاریخ' },
  { id: '019fa55c-622b-75d6-906f-b36684b29312', key: 'Customer Selection', en: 'Customer Selection', ar: 'اختيار العميل', ur: 'کسٹمر کا انتخاب' },
  { id: '019fa55c-622b-7032-b6d2-dde1a23ef1e5', key: 'Save and Record Quotation', en: 'Save and Record Quotation', ar: 'حفظ وتسجيل عرض السعر', ur: 'کوٹیشن محفوظ کریں اور ریکارڈ کریں' },
  { id: '019fa55c-622b-70bf-93b7-32d39c652709', key: 'Expense Issue Date', en: 'Expense Issue Date', ar: 'تاريخ إصدار المصروف', ur: 'اخراجات جاری ہونے کی تاریخ' },
  { id: '019fa55c-622b-7d61-a8a6-6b9a0c51741e', key: 'Input Tax Slab', en: 'Input Tax Slab', ar: 'شريحة ضريبة المدخلات', ur: 'ان پٹ ٹیکس سلیب' },
  { id: '019fa55c-622b-7ec8-96df-5c1d778980b5', key: 'Disbursement Bank', en: 'Disbursement Bank', ar: 'بنك الصرف', ur: 'ادائیگی کرنے والا بینک' },
  { id: '019fa55c-622b-7624-9876-83c1197b3385', key: 'Pending Outstanding payment', en: 'Pending Outstanding payment', ar: 'دفعات معلقة مستحقة', ur: 'زیر التواء واجب الادا ادائیگی' },
  { id: '019fa55c-622b-7d98-ad6b-0dd1484ebc69', key: 'Procurement Classification', en: 'Procurement Classification', ar: 'تصنيف المشتريات', ur: 'خریداری کی درجہ بندی' },
  { id: '019fa55c-622b-7e73-aacf-c6e8a039206f', key: 'Operating Expense (OpEx)', en: 'Operating Expense (OpEx)', ar: 'مصاريف تشغيلية (OpEx)', ur: 'آپریٹنگ اخراجات (OpEx)' },
  { id: '019fa55c-622b-7435-817a-00458ff5c515', key: 'Capital Expense (CapEx) / Asset Acquisition', en: 'Capital Expense (CapEx) / Asset Acquisition', ar: 'مصاريف رأس مالية (CapEx) / شراء أصول', ur: 'سرمایہ کاری کے اخراجات (CapEx) / اثاثہ کا حصول' },
  { id: '019fa55c-622b-7136-87e6-9b43f032685d', key: 'Asset Category', en: 'Asset Category', ar: 'فئة الأصول', ur: 'اثاثہ کی قسم' },
  { id: '019fa55c-622b-74aa-ac77-05b038a789ec', key: 'Asset Useful Depreciation Life (Months)', en: 'Asset Useful Depreciation Life (Months)', ar: 'العمر الاستهلاكي النافع للأصل (بالأشهر)', ur: 'اثاثہ کی فرسودگی کی مدت (مہینوں میں)' },
  { id: '019fa55c-622b-7b8c-b16f-22070e6f14ec', key: 'Item Description / Material Catalog', en: 'Item Description / Material Catalog', ar: 'وصف البند / كتالوج المواد', ur: 'آئٹم کی تفصیل / میٹریل کیٹلاگ' },
  { id: '019fa55c-622b-7e36-bda3-a1989151a333', key: 'Material Unit Price', en: 'Material Unit Price', ar: 'سعر وحدة المادة', ur: 'خام مال کی فی یونٹ قیمت' },
  { id: '019fa55c-622b-73ac-a18e-680ca6636d0c', key: 'Sourced Qty', en: 'Sourced Qty', ar: 'الكمية الموردة', ur: 'حاصل کردہ مقدار' },
  { id: '019fa55c-622b-7d48-b07d-be29a6923c45', key: 'Add Procurement Row', en: 'Add Procurement Row', ar: 'إضافة سطر مشتريات', ur: 'خریداری کی لائن شامل کریں' },
  { id: '019fa55c-622c-7797-b316-f96ca677520a', key: 'Commit and Log Expense', en: 'Commit and Log Expense', ar: 'اعتماد وتسجيل المصروف', ur: 'اخراجات ریکارڈ اور محفوظ کریں' },
  { id: '019fa55c-622c-7710-9cec-8b54c9824ae3', key: 'Point of Sale (POS)', en: 'Point of Sale (POS)', ar: 'نقطة البيع (POS)', ur: 'پوائنٹ آف سیل (POS)' },
  { id: '019fa55c-622c-7c80-86b0-adb6b1d44157', key: 'Terminal', en: 'Terminal', ar: 'جهاز البيع', ur: 'ٹرمینل' },
  { id: '019fa55c-622c-7771-a61d-4492ba2fe2d4', key: 'Pending (Held)', en: 'Pending (Held)', ar: 'المعلقة (المحفوظة)', ur: 'التواء (محفوظ)' },
  { id: '019fa55c-622c-7af2-88f7-b8314a844a7d', key: 'Sales History', en: 'Sales History', ar: 'سجل المبيعات', ur: 'فروخت کی تاریخ' },
  { id: '019fa55c-622c-77c0-90ed-f36c2f5d4ae2', key: 'Shifts & Z-Reports', en: 'Shifts & Z-Reports', ar: 'الورديات وتقارير Z', ur: 'شفٹس اور زیڈ رپورٹیں' },
  { id: '019fa55c-622c-72c4-96cc-32ae766502ed', key: 'Error attempting to enable fullscreen:', en: 'Error attempting to enable fullscreen:', ar: 'خطأ أثناء محاولة تفعيل ملء الشاشة:', ur: 'فل سکرین فعال کرنے کی کوشش میں خرابی:' },
  { id: '019fa55c-622c-7d6b-9559-8185b6f5ebeb', key: 'Customer selection is mandatory for pending (held) payments.', en: 'Customer selection is mandatory for pending (held) payments.', ar: 'اختيار العميل إلزامي للمدفوعات المعلقة (المحفوظة).', ur: 'زیر التواء (محفوظ) ادائیگیوں کے لیے کسٹمر کا انتخاب لازمی ہے۔' },
  { id: '019fa55c-622c-79cf-94f3-2b19368a0a97', key: 'Please select a payment method (Bank/Cash).', en: 'Please select a payment method (Bank/Cash).', ar: 'يرجى اختيار طريقة الدفع (البنك/النقد).', ur: 'براہ کرم ادائیگی کا طریقہ منتخب کریں (بینک/کیش)۔' },
  { id: '019fa55c-622c-7143-bdb6-3cf6cf31320f', key: 'No bank accounts configured. Please configure at least one bank account.', en: 'No bank accounts configured. Please configure at least one bank account.', ar: 'لم يتم تكوين أي حسابات مصرفية. يرجى تكوين حساب مصرفي واحد على الأقل.', ur: 'کوئی بینک اکاؤنٹ کنفیگر نہیں ہے۔ براہ کرم کم از کم ایک بینک اکاؤنٹ کنفیگر کریں۔' },
  { id: '019fa55c-622c-745a-a545-c54f15c4c851', key: 'POS Sale', en: 'POS Sale', ar: 'مبيعات نقطة البيع', ur: 'پی او ایس سیل' },
  { id: '019fa55c-622c-7301-a2a2-a38691fc5dc3', key: 'Receipt printing simulated!', en: 'Receipt printing simulated!', ar: 'تمت محاكاة طباعة الإيصال!', ur: 'رسید کی پرنٹنگ کا تخمینہ لگایا گیا ہے!' },
  { id: '019fa55c-622c-7582-b51f-718c17610722', key: 'Search by name, SKU, or Barcode...', en: 'Search by name, SKU, or Barcode...', ar: 'البحث بالاسم أو رمز SKU أو الباركود...', ur: 'نام، SKU، یا بارکوڈ کے ذریعے تلاش کریں...' },
  { id: '019fa55c-622c-7d0b-974b-3211b47a51a6', key: 'Toggle Fullscreen (Esc to exit to Dashboard)', en: 'Toggle Fullscreen (Esc to exit to Dashboard)', ar: 'تبديل ملء الشاشة (Esc للعودة للوحة القيادة)', ur: 'فل سکرین تبدیل کریں (لوحہ پر واپس جانے کے لیے Esc دبائیں)' },
  { id: '019fa55c-622c-7ee1-bf7d-ec8bb1582c35', key: 'No products found in this category.', en: 'No products found in this category.', ar: 'لا توجد منتجات في هذه الفئة.', ur: 'اس زمرے میں کوئی مصنوعات نہیں ملیں۔' },
  { id: '019fa55c-622c-7800-969b-31e0d4d2f957', key: 'Current Sale', en: 'Current Sale', ar: 'البيع الحالي', ur: 'موجودہ فروخت' },
  { id: '019fa55c-622c-7477-90db-9f26f1ddf112', key: 'End Shift', en: 'End Shift', ar: 'إنهاء الوردية', ur: 'شفٹ ختم کریں' },
  { id: '019fa55c-622c-77a2-8da5-4fb0b8e2142d', key: 'Cart is empty', en: 'Cart is empty', ar: 'السلة فارغة', ur: 'کارٹ خالی ہے' },
  { id: '019fa55c-622c-79dc-8c3e-d3c23f7d0f72', key: 'Total', en: 'Total', ar: 'الإجمالي', ur: 'کل' },
  { id: '019fa55c-622c-7901-97b9-7e56656d0094', key: 'Hold', en: 'Hold', ar: 'تعليق', ur: 'محفوظ کریں' },
  { id: '019fa55c-622c-7bd1-aba8-71fbc7bd9e43', key: 'Void', en: 'Void', ar: 'إلغاء السلة', ur: 'منسوخ کریں' },
  { id: '019fa55c-622c-7175-8e63-1af48c468c1d', key: 'Pay Now', en: 'Pay Now', ar: 'الدفع الآن', ur: 'ابھی ادائیگی کریں' },
  { id: '019fa55c-622c-75ab-929e-ae1292b300a5', key: 'Pay', en: 'Pay', ar: 'دفع', ur: 'ادائیگی' },
  { id: '019fa55c-622c-7330-a318-ea70e4d8b7fb', key: 'Close Modals / Exit FS', en: 'Close Modals / Exit FS', ar: 'إغلاق النوافذ / الخروج من ملء الشاشة', ur: 'موڈلز بند کریں / فل سکرین سے باہر نکلیں' },
  { id: '019fa55c-622c-7250-8860-62cde9ee80d5', key: 'Exit Fullscreen', en: 'Exit Fullscreen', ar: 'الخروج من ملء الشاشة', ur: 'فل سکرین سے باہر نکلیں' },
  { id: '019fa55c-622c-722c-83ac-a172bccfc895', key: 'Enter Fullscreen', en: 'Enter Fullscreen', ar: 'الدخول في ملء الشاشة', ur: 'فل سکرین میں داخل ہوں' },
  { id: '019fa55c-622c-75ef-9ec6-61d9d9ca07c8', key: 'Hold Invoice (Pending)', en: 'Hold Invoice (Pending)', ar: 'تعليق الفاتورة (معلقة)', ur: 'انوائس کو روکیں (زیر التواء)' },
  { id: '019fa55c-622c-799e-a19a-72563c1fb2ed', key: 'Please select a customer. This is mandatory for pending payments to save for future reference.', en: 'Please select a customer. This is mandatory for pending payments to save for future reference.', ar: 'يرجى تحديد العميل. هذا إلزامي للمدفوعات المعلقة لحفظها للرجوع إليها في المستقبل.', ur: 'براہ کرم ایک کسٹمر منتخب کریں۔ مستقبل کے حوالے کے لیے بچانے کے لیے یہ زیر التواء ادائیگیوں کے لیے لازمی ہے۔' },
  { id: '019fa55c-622c-78e5-9ccf-9d4ea05cece7', key: 'Select Customer *', en: 'Select Customer *', ar: 'تحديد العميل *', ur: 'کسٹمر منتخب کریں *' },
  { id: '019fa55c-622c-76ea-aea3-2c5246455757', key: '-- Choose Customer --', en: '-- Choose Customer --', ar: '-- اختر العميل --', ur: '-- کسٹمر منتخب کریں --' },
  { id: '019fa55c-622c-7000-8d03-ebb17fcb8582', key: 'Save Pending', en: 'Save Pending', ar: 'حفظ كمعلقة', ur: 'زیر التواء محفوظ کریں' },
  { id: '019fa55c-622c-74b4-b46d-0f4af331e2c7', key: 'Complete Payment', en: 'Complete Payment', ar: 'إتمام عملية الدفع', ur: 'ادائیگی مکمل کریں' },
  { id: '019fa55c-622c-7e46-a4df-d2c4bb097401', key: 'Amount Due', en: 'Amount Due', ar: 'المبلغ المستحق', ur: 'واجب الادا رقم' },
  { id: '019fa55c-622c-77e3-89cb-8a023cce419f', key: 'Payment Method / Bank Account *', en: 'Payment Method / Bank Account *', ar: 'طريقة الدفع / الحساب المصرفي *', ur: 'ادائیگی کا طریقہ / بینک اکاؤنٹ *' },
  { id: '019fa55c-622c-783e-b3f3-37ee4e556c12', key: '-- Select Register/Bank --', en: '-- Select Register/Bank --', ar: '-- اختر الصندوق/البنك --', ur: '-- رجسٹر/بینک منتخب کریں --' },
  { id: '019fa55c-622c-7f02-a3ca-34b73a0052ea', key: 'Cash Register (Default)', en: 'Cash Register (Default)', ar: 'صندوق النقدية (الافتراضي)', ur: 'کیش رجسٹر (ڈیفالٹ)' },
  { id: '019fa55c-622c-7838-9eb1-bf2c8c191053', key: 'Received Amount', en: 'Received Amount', ar: 'المبلغ المستلم', ur: 'وصول شدہ رقم' },
  { id: '019fa55c-622c-795f-9db9-10b6a72e012f', key: 'Change (Rounded)', en: 'Change (Rounded)', ar: 'المتبقي (مقرب)', ur: 'باقی رقم (گول)' },
  { id: '019fa55c-622c-7dd7-92d8-978c7dff3adc', key: 'Customer (Optional for paid)', en: 'Customer (Optional for paid)', ar: 'العميل (اختياري للمدفوع)', ur: 'کسٹمر (ادائیگی کی صورت میں اختیاري)' },
  { id: '019fa55c-622c-7fb5-89a9-31cc0af76b33', key: 'Walk-in Customer (Default)', en: 'Walk-in Customer (Default)', ar: 'عميل عابر (الافتراضي)', ur: 'عام گاہک (ڈیفالٹ)' },
  { id: '019fa55c-622c-70ff-b509-0c2ba609f076', key: 'Confirm Payment', en: 'Confirm Payment', ar: 'تأكيد الدفع', ur: 'ادائیگی کی تصدیق کریں' },
  { id: '019fa55c-622c-7bd4-ac5a-eb0d314cb097', key: 'Please count the cash in drawer and enter the total below.', en: 'Please count the cash in drawer and enter the total below.', ar: 'يرجى عد النقد في الدرج وإدخال الإجمالي أدناه.', ur: 'براہ کرم دراز میں موجود نقد رقم گنیں اور نیچے کل رقم درج کریں۔' },
  { id: '019fa55c-622c-77ba-bfc9-a44d80b160da', key: 'Actual Cash in Drawer', en: 'Actual Cash in Drawer', ar: 'النقد الفعلي في الدرج', ur: 'دراز میں موجود اصل نقد رقم' },
  { id: '019fa55c-622c-71fa-9a9d-2f523badf488', key: 'Close Shift', en: 'Close Shift', ar: 'إغلاق الوردية', ur: 'شفٹ بند کریں' },
  { id: '019fa55c-622c-7dbf-a90a-c732fe6383e8', key: 'Pending (Held) Invoices', en: 'Pending (Held) Invoices', ar: 'الفواتير المعلقة (المحفوظة)', ur: 'زیر التواء (محفوظ) انوائسز' },
  { id: '019fa55c-622c-7ec3-a237-6ffba6625758', key: 'Reference', en: 'Reference', ar: 'المرجع', ur: 'حوالہ' },
  { id: '019fa55c-622c-7b80-b981-8ad129f57d07', key: 'Unknown', en: 'Unknown', ar: 'غير معروف', ur: 'نامعلوم' },
  { id: '019fa55c-622c-7c3a-9375-fef5fd671e32', key: 'items', en: 'items', ar: 'مواد', ur: 'اشیاء' },
  { id: '019fa55c-622c-7439-956e-b2e38caa5fa9', key: 'Resume', en: 'Resume', ar: 'استئناف', ur: 'دوبارة شروع کریں' },
  { id: '019fa55c-622c-7cd5-b21e-e85805e5dddc', key: 'No pending invoices.', en: 'No pending invoices.', ar: 'لا توجد فواتير معلقة.', ur: 'کوئی زیر التواء انوائس نہیں ہے۔' },
  { id: '019fa55c-622c-74bc-8be5-138f25df3ccd', key: 'POS Sales History', en: 'POS Sales History', ar: 'سجل مبيعات نقطة البيع', ur: 'پی او ایس فروخت کی تاریخ' },
  { id: '019fa55c-622c-7130-9d44-a5e878efe50a', key: 'Walk-in', en: 'Walk-in', ar: 'زبون عابر', ur: 'عام گاہک' },
  { id: '019fa55c-622c-713a-bdd1-931f1de28611', key: 'No POS invoices found.', en: 'No POS invoices found.', ar: 'لم يتم العثور على فواتير لنقطة البيع.', ur: 'پی او ایس کی کوئی انوائس نہیں ملی۔' },
  { id: '019fa55c-622c-7992-a459-30a45a4f4d3c', key: 'History', en: 'History', ar: 'السجل', ur: 'تاریخ' },
  { id: '019fa55c-622c-70dd-8f6e-2736bf257ea4', key: 'Shift Audit', en: 'Shift Audit', ar: 'تدقيق الوردية', ur: 'شفٹ آڈٹ' },
  { id: '019fa55c-622c-7bc4-818f-69c0b85372b5', key: 'to', en: 'to', ar: 'إلى', ur: 'تک' },
  { id: '019fa55c-622c-7566-80e0-9aee5d495b4f', key: 'Shift Time', en: 'Shift Time', ar: 'وقت الوردية', ur: 'شفٹ کا وقت' },
  { id: '019fa55c-622c-71fe-b41a-9661bd1b3e3e', key: 'Start Cash', en: 'Start Cash', ar: 'نقد البداية', ur: 'ابتدائی کیش' },
  { id: '019fa55c-622c-79cc-9918-b17de2c578ad', key: 'Total Sales', en: 'Total Sales', ar: 'إجمالي المبيعات', ur: 'کل فروخت' },
  { id: '019fa55c-622c-7614-a222-7f0ef45a063b', key: 'Expected End', en: 'Expected End', ar: 'النهاية المتوقعة', ur: 'متوقع اختتام' },
  { id: '019fa55c-622c-78fd-ad53-72504b17e3e7', key: 'Actual End', en: 'Actual End', ar: 'النهاية الفعلية', ur: 'اصل اختتام' },
  { id: '019fa55c-622c-7d69-9d3c-6de2b363bba2', key: 'No shifts recorded for selected period.', en: 'No shifts recorded for selected period.', ar: 'لم يتم تسجيل ورديات للفترة المحددة.', ur: 'منتخب مدت کے لیے کوئی شفٹ ریکارڈ نہیں کی گئی۔' },
  { id: '019fa55c-622c-7ec4-a2bb-8779f3e53ae5', key: 'Cashier Variance Report', en: 'Cashier Variance Report', ar: 'تقرير فروقات أمين الصندوق', ur: 'کیشیئر کے فرق کی رپورٹ' },
  { id: '019fa55c-622c-7f4b-80d5-3fe78e01edff', key: 'Cashier', en: 'Cashier', ar: 'أمين الصندوق', ur: 'کیشیئر' },
  { id: '019fa55c-622c-7a00-9873-82e7c0de7940', key: 'Expected', en: 'Expected', ar: 'المتوقع', ur: 'متوقع' },
  { id: '019fa55c-622c-76f6-9d3b-fbaf1d494ac6', key: 'Variance', en: 'Variance', ar: 'الفرق', ur: 'فرق' },
  { id: '019fa55c-622c-7cf2-a161-a9c2df25ce00', key: 'Active Organization', en: 'Active Organization', ar: 'المنظمة النشطة', ur: 'فعال تنظیم' },
  { id: '019fa55c-622c-7e6f-a67e-42862f0f27d1', key: 'Assigned Company', en: 'Assigned Company', ar: 'الشركة المعينة', ur: 'تفویض شدہ کمپنی' },
  { id: '019fa55c-622c-7bc1-a5f3-f9219debae0f', key: 'Fiscal Status', en: 'Fiscal Status', ar: 'الحالة المالية', ur: 'مالی حیثیت' },
  { id: '019fa55c-622c-77e4-be6e-f327cf810e20', key: 'Month Open:', en: 'Month Open:', ar: 'الشهر المفتوح:', ur: 'کھلا مہینہ:' },
  { id: '019fa55c-622c-7b35-b79b-4c157ed73d59', key: 'No Month Open', en: 'No Month Open', ar: 'لا يوجد شهر مفتوح', ur: 'کوئی مہینہ کھلا نہیں' },
  { id: '019fa55c-622c-7727-8235-e40a7fd23abf', key: 'Doc No', en: 'Doc No', ar: 'رقم المستند', ur: 'دستاویز نمبر' },
  { id: '019fa55c-622c-7aa5-b95e-bf7313276211', key: 'Date', en: 'Date', ar: 'التاريخ', ur: 'تاریخ' },
  { id: '019fa55c-622c-7ab8-967d-6eeebdd7c748', key: 'Customer', en: 'Customer', ar: 'العميل', ur: 'کسٹمر' },
  { id: '019fa55c-622c-73a8-a297-f6562ebea029', key: 'Grand Total', en: 'Grand Total', ar: 'الإجمالي الكلي', ur: 'کل رقم' },
  { id: '019fa55c-622c-7ca2-953a-2d938646e55c', key: 'Status', en: 'Status', ar: 'الحالة', ur: 'حیثیت' },
  { id: '019fa55c-622c-765a-aff5-604a28f21c43', key: 'Actions', en: 'Actions', ar: 'الإجراءات', ur: 'اقدامات' },
  { id: '019fa55c-622c-7f09-9593-a10125a722de', key: 'Invoice No', en: 'Invoice No', ar: 'رقم الفاتورة', ur: 'انوائس نمبر' },
  { id: '019fa55c-622c-73f6-ae9c-78f1a5a37293', key: 'Post Bank', en: 'Post Bank', ar: 'البنك المودع', ur: 'بینک' },
  { id: '019fa55c-622c-7353-8592-1cbf4620086c', key: 'Payment', en: 'Payment', ar: 'الدفع', ur: 'ادائیگی' },
  { id: '019fa55c-622c-70c8-bdd4-8eb9f143d9fe', key: 'New Quotation', en: 'New Quotation', ar: 'عرض سعر جديد', ur: 'نیا کوٹیشن' },
  { id: '019fa55c-622c-71a9-ba74-4c5c5049bdf5', key: 'Issue Invoice', en: 'Issue Invoice', ar: 'إصدار فاتورة', ur: 'انوائس جاری کریں' },
  { id: '019fa55c-622c-7c2d-9879-b960a9eb43e7', key: 'Reload View', en: 'Reload View', ar: 'تحديث العرض', ur: 'دوبارہ لوڈ کریں' },
  { id: '019fa55c-622c-762c-96a7-fdf7b5ad173c', key: 'Product Categories', en: 'Product Categories', ar: 'فئات المنتجات', ur: 'مصنوعات کے زمرے' },
  { id: '019fa55c-622c-7367-a2d7-a61f692f627b', key: 'Units of Measure', en: 'Units of Measure', ar: 'وحدات القياس', ur: 'پیمائش کی اکائیاں' },
  { id: '019fa55c-622c-7124-8bb4-d46700df3669', key: 'Physical Warehouses', en: 'Physical Warehouses', ar: 'المستودعات الفعلية', ur: 'طبیعی گودام' },
  { id: '019fa55c-622c-7fe4-a56e-f58bdde76684', key: 'Define product hierarchy and Map material types to specific GL accounting groups.', en: 'Define product hierarchy and Map material types to specific GL accounting groups.', ar: 'تحديد الهيكل الهرمي للمنتج ورسم خرائط لأنواع المواد لمجموعات محاسبية معينة.', ur: 'مصنوعات کے درجہ بندی کی وضاحت کریں اور مادی اقسام کو مخصوص GL اکاؤنٹنگ گروپس کے ساتھ منسلک کریں۔' },
  { id: '019fa55c-622c-70ef-aaf3-2e523988eeaf', key: 'Configure standardized weights, dimensions, volumes, and UoM conversion units.', en: 'Configure standardized weights, dimensions, volumes, and UoM conversion units.', ar: 'تكوين الأوزان والأبعاد والأحجام الموحدة ووحدات التحويل.', ur: 'معیاری وزن، طول و عرض، حجم، اور پیمائش کی تبدیلی کے یونٹس کو ترتیب دیں۔' },
  { id: '019fa55c-622c-7867-9d94-e613b2e4dad6', key: 'Setup and govern multiple physical storage locations, distribution centers, and shop floors.', en: 'Setup and govern multiple physical storage locations, distribution centers, and shop floors.', ar: 'إعداد وإدارة مواقع التخزين المادية المتعددة ومراكز التوزيع وورش العمل.', ur: 'متعدد طبیعی اسٹوریج مقامات، تقسیمی مراکز، اور دکان کے فرش قائم اور کنٹرول کریں۔' }
];

export const INITIAL_DB: DatabaseState = {
  companies: SEED_COMPANIES,
  selectedCompanyId: SEED_COMPANIES[0].id,
  users: SEED_USERS,
  currentUser: SEED_USERS[0],
  companySetup: SEED_COMPANIES[0],
  templates: SEED_TEMPLATES,
  taxSlabs: SEED_TAX_SLABS,
  products: SEED_PRODUCTS,
  customers: SEED_CUSTOMERS,
  vendors: SEED_VENDORS,
  banks: SEED_BANKS,
  months: SEED_MONTHS,
  quotations: [],
  invoices: [],
  expenses: [],
  recurringTemplates: SEED_RECURRING,
  recurringPostings: [],
  vouchers: [],
  translations: SEED_TRANSLATIONS,
  investors: [],
  posShifts: [],
  posHeldInvoices: [],
  warehouses: [
    { id: '019fa55c-622c-7d33-b9d3-5d352934e231', name: 'Main Shop Floor', code: 'MAIN-01', address: 'Old Saneya Riyadh', isActive: true, companyId: '019fa55c-622a-736c-ba38-beb9f2291fe3' },
    { id: '019fa55c-622c-7b06-8c01-2429ef1996e7', name: 'Raw Wood Warehouse', code: 'WOOD-WH', address: 'Old Saneya Riyadh', isActive: true, companyId: '019fa55c-622a-7cd5-b949-e61689455b41' }
  ],
  purchaseRequisitions: [],
  purchaseOrders: [],
  goodsReceiptNotes: [],
  inventoryStocks: [],
  counters: {
    quotation: 1001,
    invoice: 1001,
    expense: 1001,
    voucher: 1001
  }
};

const LOCAL_STORAGE_KEY = 'cnc_fabrication_portal_db_v3';

export function getDatabase(): DatabaseState {
  return JSON.parse(JSON.stringify(INITIAL_DB));
}

export function saveDatabase(db: DatabaseState): void {
  // No-op: Only state in Postgres is kept (single source of database)
}

// Validation helpers
export function getAndIncrementCounter(db: DatabaseState, type: 'quotation' | 'invoice' | 'expense' | 'voucher', companyId: string): { db: DatabaseState; value: number } {
  const companyIndex = db.companies.findIndex(c => c.id === companyId);
  if (companyIndex !== -1) {
    const comp = db.companies[companyIndex];
    if (!comp.counters) {
      comp.counters = { quotation: 1001, invoice: 1001, expense: 1001, voucher: 1001 };
    }
    const val = comp.counters[type];
    comp.counters[type] = val + 1;
    
    // Sync active companySetup if it matches
    if (db.selectedCompanyId === companyId) {
      db.companySetup = { ...comp };
    }
    return { db, value: val };
  } else {
    // Fallback
    const val = db.counters[type];
    db.counters[type] = val + 1;
    return { db, value: val };
  }
}

// Multiple fiscal months can be open concurrently for a company (cap of 3, enforced in
// openNewMonth/closeMonth below and server-side in server/routes/transactions.ts). Returns
// every currently-open month for the company, sorted oldest-first (ids are "YYYY-MM", so a
// plain string sort is chronological).
export function getOpenMonths(db: DatabaseState, companyId?: string): FiscalMonth[] {
  const compId = companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';
  return db.months
    .filter(m => m.status?.toLowerCase() === 'open' && m.companyId === compId)
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Historically this returned "the" single open month back when only one could ever be open.
// Now that several can be open at once, callers that just need a sensible single value (a
// date-picker default, a "some month is open" status pill) get the OLDEST open month — the one
// closest to needing attention and the only one currently eligible to be closed. Callers that
// need to validate a specific date must NOT use this — use validateTransactionDate/
// isDateInOpenMonth instead, which check the fiscal month matching that date's own YYYY-MM.
export function getActiveOpenMonth(db: DatabaseState, companyId?: string): FiscalMonth | undefined {
  return getOpenMonths(db, companyId)[0];
}

// The one company-scoped default tax slab (server-enforced: at most one per company,
// see src/db/schema.ts's unique_default_tax_slab). Every document form (Quotation/
// Invoice/Expense/POS/Inventory PR-PO-GRN) previously guessed a default independently
// via its own ad-hoc heuristic — "find a 0% slab", "find a 15% slab", or just
// db.taxSlabs[0] — which silently produced the wrong default for any company whose
// actual default didn't match that specific guess, and drifted out of sync across
// forms since each one guessed differently. This is a pre-fill default only — every
// caller of this must remain fully editable per-document/per-line, never a locked value.
export function getDefaultTaxSlabId(db: DatabaseState, companyId?: string): string {
  const compId = companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';
  return db.taxSlabs.find(t => t.companyId === compId && t.isDefault)?.id
    || db.taxSlabs.find(t => !t.companyId && t.isDefault)?.id
    || db.taxSlabs.find(t => t.companyId === compId)?.id
    || db.taxSlabs[0]?.id
    || '';
}

// Is there an OPEN fiscal month whose id equals this date's own YYYY-MM? (Not "does this date
// fall in THE one open month" — with multiple months open concurrently, a date can be valid
// even if it's not in the oldest/first open month.)
export function isDateInOpenMonth(db: DatabaseState, dateStr: string, companyId?: string): boolean {
  const compId = companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';
  const monthId = dateStr.substring(0, 7);
  return db.months.some(m => m.id === monthId && m.companyId === compId && m.status?.toLowerCase() === 'open');
}

export function validateTransactionDate(db: DatabaseState, dateStr: string, companyId?: string): { valid: boolean; error?: string } {
  const compId = companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';
  const openMonths = getOpenMonths(db, compId);
  if (openMonths.length === 0) {
    return { valid: false, error: 'There is no open fiscal month. Admin must open a fiscal month first.' };
  }

  // Date format is YYYY-MM-DD, fiscal month id is YYYY-MM. Valid if the SPECIFIC month this
  // date falls in is open — not just if some other month happens to be open.
  const monthId = dateStr.substring(0, 7);
  const matchingOpenMonth = openMonths.find(m => m.id === monthId);
  if (!matchingOpenMonth) {
    const openList = openMonths.map(m => `${m.name} (${m.id})`).join(', ');
    return {
      valid: false,
      error: `Transaction date (${dateStr}) does not fall within any currently open fiscal month. Open month(s): ${openList}.`
    };
  }

  return { valid: true };
}

// Auto-save typed sales items that do not exist in products catalogue
export function ensureSalesProductExists(db: DatabaseState, nameAndDesc: string, cost: number, companyId?: string): DatabaseState {
  const trimName = nameAndDesc.trim();
  if (!trimName) return db;
  
  const compId = companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';
  const exists = db.products.some(p => p.name.toLowerCase() === trimName.toLowerCase() && p.type === 'Sales' && p.companyId === compId);
  if (!exists) {
    const newProduct: ProductService = {
      id: generateId(),
      name: trimName,
      description: `Automatically created during quotation/invoice entry for "${trimName}"`,
      unitPrice: cost,
      type: 'Sales',
      companyId: compId
    };
    db.products.push(newProduct);
  }
  return db;
}

// Calculate totals for quotations or invoices
export function calculateInvoiceTotals(
  db: DatabaseState,
  items: Array<{ unitCost: number; quantity: number; discountAmount?: number; taxSlabId?: string; taxRate?: number }>,
  taxSlabId: string,
  discountPercentage?: number
) {
  const taxSlabsList = db.taxSlabs || (db as any).taxSlabs || [];
  const defaultHeaderTaxSlab = taxSlabsList.find((t: any) => t.id === taxSlabId);
  const defaultHeaderRate = defaultHeaderTaxSlab ? defaultHeaderTaxSlab.percentage : 0;

  let grossSubtotal = 0;
  let totalLineDiscount = 0;
  let taxAmount = 0;

  const headerDiscountFactor = 1 - ((discountPercentage || 0) / 100);

  items.forEach(item => {
    const itemGross = item.unitCost * item.quantity;
    const itemLineDisc = (item.discountAmount || 0) * item.quantity;
    const itemSubtotal = Math.max(0, itemGross - itemLineDisc);
    const itemDiscountedSubtotal = itemSubtotal * headerDiscountFactor;

    let itemRate = defaultHeaderRate;
    if (item.taxRate !== undefined && item.taxRate !== null && !isNaN(item.taxRate)) {
      itemRate = item.taxRate;
    } else if (item.taxSlabId) {
      const slab = taxSlabsList.find((t: any) => t.id === item.taxSlabId);
      if (slab) itemRate = slab.percentage;
    }

    grossSubtotal += itemGross;
    totalLineDiscount += itemLineDisc;
    taxAmount += itemDiscountedSubtotal * (itemRate / 100);
  });

  const subtotal = Math.max(0, grossSubtotal - totalLineDiscount);
  const headerDiscount = subtotal * ((discountPercentage || 0) / 100);
  const discountedSubtotal = Math.max(0, subtotal - headerDiscount);
  const totalDiscount = totalLineDiscount + headerDiscount;
  const grandTotal = discountedSubtotal + taxAmount;

  return {
    grossSubtotal: Number(grossSubtotal.toFixed(2)),
    totalLineDiscount: Number(totalLineDiscount.toFixed(2)),
    subtotal: Number(subtotal.toFixed(2)),
    discountAmount: Number(headerDiscount.toFixed(2)),
    totalDiscount: Number(totalDiscount.toFixed(2)),
    discountedSubtotal: Number(discountedSubtotal.toFixed(2)),
    taxAmount: Number(taxAmount.toFixed(2)),
    grandTotal: Number(grandTotal.toFixed(2)),
    percentage: defaultHeaderRate
  };
}

// ----------------------------------------
// TRANSACTION OPERATIONS (with AUTO-VOUCHERS)
// ----------------------------------------

// Add Quotation
export function saveQuotation(db: DatabaseState, qData: Omit<Quotation, 'id' | 'quotationNumber' | 'createdById' | 'createdAt'>): { db: DatabaseState; error?: string } {
  const companyId = qData.companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';
  const dateCheck = validateTransactionDate(db, qData.date, companyId);
  if (!dateCheck.valid) return { db, error: dateCheck.error };
  
  if (qData.items.length === 0) return { db, error: 'At least one line item is required.' };
  
  // Validate items
  for (const item of qData.items) {
    if (!item.description.trim()) return { db, error: 'Item description is mandatory.' };
    if (isNaN(item.unitCost) || item.unitCost < 0) return { db, error: 'Item unit cost must be a valid positive number.' };
  }

  const { db: updatedDb, value: qCount } = getAndIncrementCounter(db, 'quotation', companyId);
  db = updatedDb;
  const qNumber = `QT-${qCount}`;
  const newQuotation: Quotation = {
    ...qData,
    companyId,
    id: generateId(),
    quotationNumber: qNumber,
    createdById: db.currentUser.id,
    createdAt: new Date().toISOString()
  };

  // Ensure items are saved to master
  for (const item of qData.items) {
    db = ensureSalesProductExists(db, item.description, item.unitCost, companyId);
  }

  db.quotations.push(newQuotation);
  

  return { db };
}

// Edit Quotation
export function updateQuotation(db: DatabaseState, qId: string, qData: Partial<Quotation>): { db: DatabaseState; error?: string } {
  const qIndex = db.quotations.findIndex(q => q.id === qId);
  if (qIndex === -1) return { db, error: 'Quotation not found.' };
  
  const existing = db.quotations[qIndex];
  if (existing.status === 'Converted') return { db, error: 'Converted quotations cannot be modified.' };

  const companyId = existing.companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';

  if (qData.date) {
    const dateCheck = validateTransactionDate(db, qData.date, companyId);
    if (!dateCheck.valid) return { db, error: dateCheck.error };
  }

  if (qData.items) {
    if (qData.items.length === 0) return { db, error: 'At least one line item is required.' };
    for (const item of qData.items) {
      if (!item.description.trim()) return { db, error: 'Item description is mandatory.' };
      if (isNaN(item.unitCost) || item.unitCost < 0) return { db, error: 'Item unit cost must be a valid positive number.' };
    }
    // Ensure items are saved to master
    for (const item of qData.items) {
      db = ensureSalesProductExists(db, item.description, item.unitCost, companyId);
    }
  }

  db.quotations[qIndex] = {
    ...existing,
    ...qData,
  } as Quotation;


  return { db };
}

// Add Invoice (with Receipt Voucher automatic posting if Paid)
export function saveInvoice(db: DatabaseState, invData: Omit<Invoice, 'id' | 'invoiceNumber' | 'createdById' | 'createdAt'>): { db: DatabaseState; newInvoice?: Invoice; error?: string } {
  const companyId = invData.companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';
  const dateCheck = validateTransactionDate(db, invData.date, companyId);
  console.log('Date check result:', dateCheck);
  if (!dateCheck.valid) return { db, error: dateCheck.error };
  
  if (invData.items.length === 0) return { db, error: 'At least one line item is required.' };
  
  for (const item of invData.items) {
    if (!item.description.trim()) {
      console.log('Validation failed: Item description is mandatory.');
      return { db, error: 'Item description is mandatory.' };
    }
    if (isNaN(item.unitCost) || item.unitCost < 0) {
      console.log('Validation failed: Item unit cost must be a valid positive number.');
      return { db, error: 'Item unit cost must be a valid positive number.' };
    }
  }

  const { db: updatedDb1, value: invCount } = getAndIncrementCounter(db, 'invoice', companyId);
  db = updatedDb1;
  const invNumber = `INV-${invCount}`;
  const invoiceId = generateId();
  
  const totals = calculateInvoiceTotals(db, invData.items, invData.taxSlabId, invData.discountPercentage);
  const newInvoice: Invoice = {
    ...invData,
    companyId,
    id: invoiceId,
    invoiceNumber: invNumber,
    createdById: db.currentUser.id,
    createdAt: new Date().toISOString(),
    amountPaid: invData.paymentStatus === 'Paid' ? totals.grandTotal : 0
  };

  // Ensure items saved to master
  for (const item of invData.items) {
    db = ensureSalesProductExists(db, item.description, item.unitCost, companyId);
  }

  db.invoices.push(newInvoice);

  // Generate Receipt Voucher if status is Paid
  if (invData.paymentStatus === 'Paid') {
    const { db: updatedDb2, value: vchCount } = getAndIncrementCounter(db, 'voucher', companyId);
    db = updatedDb2;
    const voucherNumber = `VCH-${vchCount}`;
    
    const newVoucher: Voucher = {
      id: generateId(),
      voucherNumber,
      type: 'Receipt',
      date: (invData.paymentDate || invData.date).split('T')[0],
      bankId: invData.bankId,
      amount: totals.grandTotal,
      description: `Receipt voucher generated automatically for paid invoice ${invNumber}`,
      referenceType: 'Invoice',
      referenceId: invoiceId,
      createdById: db.currentUser.id,
      createdAt: new Date().toISOString(),
      companyId,
      isPosSale: invData.isPosSale,
      shiftId: invData.shiftId
    };
    
    db.vouchers.push(newVoucher);
  }


  return { db, newInvoice };
}

// Convert Quotation to Invoice
export function convertQuotationToInvoice(
  db: DatabaseState,
  quotationId: string,
  invoiceDate: string,
  bankId: string,
  paymentStatus: 'Paid' | 'Partially Paid' | 'Unpaid',
  customItems?: InvoiceItem[],
  customDiscountPercentage?: number,
  customTaxSlabId?: string,
  customCustomerId?: string,
  customNotes?: string
): { db: DatabaseState; newInvoice?: Invoice; error?: string } {
  const qIndex = db.quotations.findIndex(q => q.id === quotationId);
  if (qIndex === -1) return { db, error: 'Quotation not found.' };
  const quotation = db.quotations[qIndex];

  const companyId = quotation.companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';

  const openMonth = getActiveOpenMonth(db, companyId);
  if (!openMonth) return { db, error: 'There is no open fiscal month.' };

  if (quotation.status !== 'Accepted') {
    return { db, error: `Only accepted quotations can be converted. Current status is: ${quotation.status}` };
  }

  const dateCheck = validateTransactionDate(db, invoiceDate, companyId);
  if (!dateCheck.valid) return { db, error: dateCheck.error };

  const { db: updatedDb1, value: invCount } = getAndIncrementCounter(db, 'invoice', companyId);
  db = updatedDb1;
  const invNumber = `INV-${invCount}`;
  const invoiceId = generateId();

  // Determine items: custom or default mapping from quotation items
  const finalItems: InvoiceItem[] = customItems ? customItems.map(item => ({
    id: item.id || generateId(),
    description: item.description,
    unitCost: item.unitCost,
    quantity: item.quantity,
    discountAmount: item.discountAmount
  })) : quotation.items.map(item => ({
    id: generateId(),
    description: item.description,
    unitCost: item.unitCost,
    quantity: item.quantity,
    discountAmount: item.discountAmount
  }));

  const finalDiscount = customDiscountPercentage !== undefined ? customDiscountPercentage : (quotation.discountPercentage || 0);
  const finalTaxSlabId = customTaxSlabId || quotation.taxSlabId;
  const finalCustomerId = customCustomerId || quotation.customerId;
  const finalNotes = customNotes !== undefined ? customNotes : `Converted from accepted quotation ${quotation.quotationNumber}. ${quotation.notes}`;

  const totals = calculateInvoiceTotals(db, finalItems, finalTaxSlabId, finalDiscount);

  const newInvoice: Invoice = {
    id: invoiceId,
    invoiceNumber: invNumber,
    date: invoiceDate,
    customerId: finalCustomerId,
    taxSlabId: finalTaxSlabId,
    bankId,
    paymentStatus,
    paymentDate: paymentStatus === 'Paid' ? invoiceDate : null,
    notes: finalNotes,
    status: 'Active',
    createdById: db.currentUser.id,
    createdAt: new Date().toISOString(),
    originQuotationId: quotationId,
    items: finalItems,
    discountPercentage: finalDiscount,
    amountPaid: paymentStatus === 'Paid' ? totals.grandTotal : 0,
    companyId
  };

  db.invoices.push(newInvoice);

  // Update Quotation Status
  db.quotations[qIndex].status = 'Converted';

  // Generate Receipt Voucher if status is Paid
  if (paymentStatus === 'Paid') {
    const { db: updatedDb2, value: vchCount } = getAndIncrementCounter(db, 'voucher', companyId);
    db = updatedDb2;
    const voucherNumber = `VCH-${vchCount}`;

    const newVoucher: Voucher = {
      id: generateId(),
      voucherNumber,
      type: 'Receipt',
      date: invoiceDate,
      bankId,
      amount: totals.grandTotal,
      description: `Receipt voucher generated automatically for paid invoice ${invNumber} (Converted from ${quotation.quotationNumber})`,
      referenceType: 'Invoice',
      referenceId: invoiceId,
      createdById: db.currentUser.id,
      createdAt: new Date().toISOString(),
      companyId
    };

    db.vouchers.push(newVoucher);
  }


  return { db, newInvoice };
}

// Update Invoice Payment Status (e.g. from Pending to Paid/Partially Paid -> generates Receipt Voucher)
export function markInvoicePaid(
  db: DatabaseState,
  invoiceId: string,
  paymentDate: string,
  bankId?: string,
  paymentAmount?: number
): { db: DatabaseState; error?: string } {
  const invIndex = db.invoices.findIndex(inv => inv.id === invoiceId);
  if (invIndex === -1) return { db, error: 'Invoice not found.' };

  const invoice = db.invoices[invIndex];
  if (invoice.status === 'Cancelled') return { db, error: 'Cancelled invoices cannot be paid.' };
  if (invoice.paymentStatus === 'Paid') return { db, error: 'Invoice is already fully paid.' };

  const companyId = invoice.companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';

  const dateCheck = validateTransactionDate(db, paymentDate, companyId);
  if (!dateCheck.valid) return { db, error: dateCheck.error };

  const targetBankId = bankId || invoice.bankId;
  const totals = calculateInvoiceTotals(db, invoice.items, invoice.taxSlabId, invoice.discountPercentage);
  const grandTotal = totals.grandTotal;

  const currentPaid = invoice.amountPaid || 0;
  const remaining = Number((grandTotal - currentPaid).toFixed(2));

  let amountToPost = remaining;
  if (paymentAmount !== undefined) {
    if (paymentAmount <= 0) return { db, error: 'Payment amount must be greater than zero.' };
    if (paymentAmount > remaining + 0.01) {
      return { db, error: `Payment amount (${paymentAmount}) exceeds the remaining balance (${remaining}).` };
    }
    amountToPost = Math.min(paymentAmount, remaining);
  }

  if (amountToPost <= 0) return { db, error: 'No remaining balance to pay.' };

  const newPaidAmount = Number((currentPaid + amountToPost).toFixed(2));

  // Update invoice
  db.invoices[invIndex].amountPaid = newPaidAmount;
  db.invoices[invIndex].paymentStatus = newPaidAmount >= grandTotal - 0.01 ? 'Paid' : 'Partially Paid';
  db.invoices[invIndex].paymentDate = paymentDate;
  db.invoices[invIndex].bankId = targetBankId;

  // Generate Receipt Voucher
  const { db: updatedDb, value: vchCount } = getAndIncrementCounter(db, 'voucher', companyId);
  db = updatedDb;
  const voucherNumber = `VCH-${vchCount}`;

  const newVoucher: Voucher = {
    id: generateId(),
    voucherNumber,
    type: 'Receipt',
    date: paymentDate,
    bankId: targetBankId,
    amount: amountToPost,
    description: `Receipt voucher generated for invoice ${invoice.invoiceNumber} payment of ${amountToPost} ${(db.companies?.find(c => c.id === companyId) || db.companySetup)?.currency || 'SAR'}`,
    referenceType: 'Invoice',
    referenceId: invoiceId,
    createdById: db.currentUser.id,
    createdAt: new Date().toISOString(),
    companyId
  };

  db.vouchers.push(newVoucher);


  return { db };
}

// Add Expense (with Payment Voucher automatic posting if Paid)
export function saveExpense(db: DatabaseState, expData: Omit<Expense, 'id' | 'expenseNumber' | 'createdById' | 'createdAt'>): { db: DatabaseState; error?: string } {
  const companyId = expData.companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';
  const dateCheck = validateTransactionDate(db, expData.date, companyId);
  if (!dateCheck.valid) return { db, error: dateCheck.error };

  const { db: updatedDb1, value: expCount } = getAndIncrementCounter(db, 'expense', companyId);
  db = updatedDb1;
  const expNumber = `EXP-${expCount}`;
  const expenseId = generateId();

  const newExpense: Expense = {
    ...expData,
    companyId,
    id: expenseId,
    expenseNumber: expNumber,
    createdById: db.currentUser.id,
    createdAt: new Date().toISOString()
  };

  db.expenses.push(newExpense);

  // Auto payment voucher generation if Paid AND is Actual (Accruals do not trigger bank vouchers until settled)
  if (expData.paymentStatus === 'Paid' && expData.type === 'Actual') {
    const { db: updatedDb2, value: vchCount } = getAndIncrementCounter(db, 'voucher', companyId);
    db = updatedDb2;
    const voucherNumber = `VCH-${vchCount}`;
    
    const newVoucher: Voucher = {
      id: generateId(),
      voucherNumber,
      type: 'Payment',
      date: expData.paymentDate || expData.date,
      bankId: expData.bankId,
      amount: expData.amount,
      description: `Payment voucher generated automatically for paid expense ${expNumber}`,
      referenceType: 'Expense',
      referenceId: expenseId,
      createdById: db.currentUser.id,
      createdAt: new Date().toISOString(),
      companyId
    };

    db.vouchers.push(newVoucher);
  }


  return { db };
}

// Update Expense Payment Status (e.g., Pending to Paid -> generates Payment Voucher)
export function markExpensePaid(
  db: DatabaseState,
  expenseId: string,
  paymentDate: string,
  bankId?: string,
  paymentAmount?: number
): { db: DatabaseState; error?: string } {
  const expIndex = db.expenses.findIndex(exp => exp.id === expenseId);
  if (expIndex === -1) return { db, error: 'Expense not found.' };

  const expense = db.expenses[expIndex];
  if (expense.status === 'Cancelled') return { db, error: 'Cancelled expenses cannot be paid.' };
  if (expense.paymentStatus === 'Paid') return { db, error: 'Expense is already paid.' };

  const companyId = expense.companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';

  const dateCheck = validateTransactionDate(db, paymentDate, companyId);
  if (!dateCheck.valid) return { db, error: dateCheck.error };

  const targetBankId = bankId || expense.bankId;
  const currentPaid = expense.amountPaid || 0;
  const remaining = Number((expense.amount - currentPaid).toFixed(2));

  let amountToPost = remaining;
  if (paymentAmount !== undefined) {
    if (paymentAmount <= 0) return { db, error: 'Payment amount must be greater than zero.' };
    if (paymentAmount > remaining + 0.01) {
      return { db, error: `Payment amount (${paymentAmount}) exceeds the remaining balance (${remaining}).` };
    }
    amountToPost = Math.min(paymentAmount, remaining);
  }

  if (amountToPost <= 0) return { db, error: 'No remaining balance to pay.' };

  const newPaidAmount = Number((currentPaid + amountToPost).toFixed(2));

  db.expenses[expIndex].amountPaid = newPaidAmount;
  db.expenses[expIndex].paymentStatus = newPaidAmount >= expense.amount - 0.01 ? 'Paid' : 'Partially Paid';
  db.expenses[expIndex].paymentDate = paymentDate; // latest payment date
  db.expenses[expIndex].bankId = targetBankId; // bank of latest payment

  // Payment voucher (only if Actual type; accrual settlement handles its own voucher when actual is posted)
  if (expense.type === 'Actual') {
    const { db: updatedDb, value: vchCount } = getAndIncrementCounter(db, 'voucher', companyId);
    db = updatedDb;
    const voucherNumber = `VCH-${vchCount}`;
    const newVoucher: Voucher = {
      id: generateId(),
      voucherNumber,
      type: 'Payment',
      date: paymentDate,
      bankId: targetBankId,
      amount: amountToPost,
      description: `Payment voucher generated for expense ${expense.expenseNumber} paid subsequently (${amountToPost.toFixed(2)})`,
      referenceType: 'Expense',
      referenceId: expenseId,
      createdById: db.currentUser.id,
      createdAt: new Date().toISOString(),
      companyId
    };
    db.vouchers.push(newVoucher);
  }


  return { db };
}

// Cancel Expense (Requires Cancellation permission, handles Reversal Voucher)
export function cancelExpense(db: DatabaseState, expenseId: string): { db: DatabaseState; error?: string } {
  const expIndex = db.expenses.findIndex(exp => exp.id === expenseId);
  if (expIndex === -1) return { db, error: 'Expense not found.' };

  const expense = db.expenses[expIndex];
  if (expense.status === 'Cancelled') return { db, error: 'Expense is already cancelled.' };

  const companyId = expense.companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';

  const openMonth = getActiveOpenMonth(db, companyId);
  if (!openMonth) return { db, error: 'There is no open fiscal month.' };

  const todayStr = new Date().toISOString().split('T')[0];
  const finalReversalDate = todayStr.startsWith(openMonth.id) ? todayStr : (expense.date.startsWith(openMonth.id) ? expense.date : openMonth.id + "-01");

  // Mark Cancelled
  db.expenses[expIndex].status = 'Cancelled';

  // If accrual, handle settlement flag?
  if (expense.type === 'Accrual' && expense.settledExpenseId) {
    // Break link in settled expense
    const actualIndex = db.expenses.findIndex(e => e.id === expense.settledExpenseId);
    if (actualIndex !== -1) {
      db.expenses[actualIndex].originAccrualId = null;
    }
  }

  // If actual, break link in accrual
  if (expense.type === 'Actual' && expense.originAccrualId) {
    const accrualIndex = db.expenses.findIndex(e => e.id === expense.originAccrualId);
    if (accrualIndex !== -1) {
      db.expenses[accrualIndex].accrualSettled = false;
      db.expenses[accrualIndex].settledExpenseId = null;
    }
  }

  // Generate Reversal Voucher if payment voucher was active
  const activePayment = db.vouchers.find(v => v.referenceId === expenseId && v.referenceType === 'Expense' && v.type === 'Payment');
  if (activePayment) {
    const { db: updatedDb, value: vchCount } = getAndIncrementCounter(db, 'voucher', companyId);
    db = updatedDb;
    const voucherNumber = `VCH-${vchCount}`;
    const reversalVoucher: Voucher = {
      id: generateId(),
      voucherNumber,
      type: 'Reversal',
      date: finalReversalDate,
      bankId: activePayment.bankId,
      amount: activePayment.amount,
      description: `Reversal voucher for cancelled expense ${expense.expenseNumber} (Original: ${activePayment.voucherNumber})`,
      referenceType: 'Expense',
      referenceId: expenseId,
      createdById: db.currentUser.id,
      createdAt: new Date().toISOString(),
      companyId
    };
    db.vouchers.push(reversalVoucher);
  }


  return { db };
}

// ----------------------------------------
// BANK TRANSACTIONS (VOUCHERS & INTER-BANK)
// ----------------------------------------

// Inter-bank Cash Transfer (Admin only)
export function saveInterBankTransfer(
  db: DatabaseState,
  sourceBankId: string,
  destBankId: string,
  amount: number,
  description: string,
  dateStr: string
): { db: DatabaseState; error?: string } {
  const sourceBank = db.banks.find(b => b.id === sourceBankId && b.isActive);
  const destBank = db.banks.find(b => b.id === destBankId && b.isActive);

  if (!sourceBank) return { db, error: 'Active source bank account not found.' };
  if (!destBank) return { db, error: 'Active destination bank account not found.' };

  const companyId = sourceBank.companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';

  const dateCheck = validateTransactionDate(db, dateStr, companyId);
  if (!dateCheck.valid) return { db, error: dateCheck.error };

  if (sourceBankId === destBankId) return { db, error: 'Source and destination bank accounts must be different.' };
  if (amount <= 0) return { db, error: 'Transfer amount must be greater than zero.' };

  const transferId = generateId();

  // Create paired transfer vouchers in the transaction list
  const { db: updatedDb1, value: vchCountOut } = getAndIncrementCounter(db, 'voucher', companyId);
  db = updatedDb1;
  const voucherNumOut = `VCH-${vchCountOut}`;
  const voucherOut: Voucher = {
    id: generateId(),
    voucherNumber: voucherNumOut,
    type: 'TransferOut',
    date: dateStr,
    bankId: sourceBankId,
    amount,
    description: `Inter-bank Transfer Out to ${destBank.bankName}: ${description}`,
    referenceType: 'Transfer',
    referenceId: transferId,
    createdById: db.currentUser.id,
    createdAt: new Date().toISOString(),
    companyId
  };

  const { db: updatedDb2, value: vchCountIn } = getAndIncrementCounter(db, 'voucher', companyId);
  db = updatedDb2;
  const voucherNumIn = `VCH-${vchCountIn}`;
  const voucherIn: Voucher = {
    id: generateId(),
    voucherNumber: voucherNumIn,
    type: 'TransferIn',
    date: dateStr,
    bankId: destBankId,
    amount,
    description: `Inter-bank Transfer In from ${sourceBank.bankName}: ${description}`,
    referenceType: 'Transfer',
    referenceId: transferId,
    createdById: db.currentUser.id,
    createdAt: new Date().toISOString(),
    companyId
  };

  db.vouchers.push(voucherOut, voucherIn);


  return { db };
}

// Bank Ledger Generation
export function generateBankLedger(db: DatabaseState, bankId: string, startDate?: string, endDate?: string): BankLedgerEntry[] {
  const bank = db.banks.find(b => b.id === bankId);
  if (!bank) return [];

  // Filter vouchers related to this bank and company
  let filteredVouchers = db.vouchers.filter(v => v.bankId === bankId && v.companyId === bank.companyId);

  // If date range is specified
  if (startDate) {
    filteredVouchers = filteredVouchers.filter(v => v.date >= startDate);
  }
  if (endDate) {
    filteredVouchers = filteredVouchers.filter(v => v.date <= endDate);
  }

  // Sort chronologically
  filteredVouchers.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));

  let runningBalance = bank.openingBalance;
  
  // Calculate running balance chronologically
  const ledger: BankLedgerEntry[] = filteredVouchers.map(v => {
    let debit = 0; // Inflow (+)
    let credit = 0; // Outflow (-)

    if (v.type === 'Receipt' || v.type === 'TransferIn') {
      debit = v.amount;
      runningBalance += v.amount;
    } else if (v.type === 'Payment' || v.type === 'TransferOut') {
      credit = v.amount;
      runningBalance -= v.amount;
    } else if (v.type === 'Reversal') {
      // Reversals can reverse either Receipt or Payment
      // We look at the reversed voucher type. Wait, we can find original voucher reference.
      // If reference is Invoice, it reversed a Receipt (so it's a CREDIT / outflow of cash)
      // If reference is Expense, it reversed a Payment (so it's a DEBIT / inflow of cash)
      if (v.referenceType === 'Invoice') {
        credit = v.amount;
        runningBalance -= v.amount;
      } else {
        debit = v.amount;
        runningBalance += v.amount;
      }
    }

    return {
      id: v.id,
      date: v.date,
      type: v.type,
      voucherNumber: v.voucherNumber,
      description: v.description,
      debit,
      credit,
      runningBalance: Number(runningBalance.toFixed(2))
    };
  });

  return ledger;
}

// Get bank current balance (including opening balance and all vouchers)
export function getBankBalance(db: DatabaseState, bankId: string): number {
  const bank = db.banks.find(b => b.id === bankId);
  if (!bank) return 0;

  const ledger = generateBankLedger(db, bankId);
  if (ledger.length === 0) return bank.openingBalance;
  return ledger[ledger.length - 1].runningBalance;
}

// ----------------------------------------
// RECURRING EXPENSES (Module 10)
// ----------------------------------------

// Post Recurring Expense as Actual or Accrual
export function postRecurringExpense(
  db: DatabaseState,
  templateId: string,
  monthId: string,
  postType: 'Actual' | 'Accrual',
  amount: number,
  dateStr: string,
  paymentStatus: 'Paid' | 'Unpaid',
  bankId: string
): { db: DatabaseState; error?: string } {
  const template = db.recurringTemplates.find(t => t.id === templateId);
  if (!template) return { db, error: 'Recurring template not found.' };

  const companyId = template.companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';

  const dateCheck = validateTransactionDate(db, dateStr, companyId);
  if (!dateCheck.valid) return { db, error: dateCheck.error };

  const postingKey = `${templateId}_${monthId}`;
  const existingPosting = db.recurringPostings.find(p => p.id === postingKey);
  if (existingPosting && existingPosting.status !== 'Unposted') {
    return { db, error: 'This recurring template is already posted for this month.' };
  }

  // Create an Expense record representing the posting
  const { db: updatedDb1, value: expCount } = getAndIncrementCounter(db, 'expense', companyId);
  db = updatedDb1;
  const expNumber = `EXP-${expCount}`;
  const expenseId = generateId();

  const newExpense: Expense = {
    id: expenseId,
    expenseNumber: expNumber,
    date: dateStr,
    vendorId: template.vendorId,
    taxSlabId: template.taxSlabId,
    bankId,
    paymentStatus: postType === 'Accrual' ? 'Unpaid' : paymentStatus,
    paymentDate: (postType === 'Actual' && paymentStatus === 'Paid') ? dateStr : null,
    description: `${template.description} (${postType} - posted for ${monthId})`,
    amount,
    status: 'Active',
    type: postType,
    createdById: db.currentUser.id,
    createdAt: new Date().toISOString(),
    items: [], // No itemized lines for general recurring posting
    companyId
  };

  db.expenses.push(newExpense);

  // Save posting status
  const newPosting: RecurringPosting = {
    id: postingKey,
    templateId,
    monthId,
    status: postType === 'Actual' ? 'Posted as Actual' : 'Posted as Accrual',
    expenseId
  };

  // Replace or add
  const pIndex = db.recurringPostings.findIndex(p => p.id === postingKey);
  if (pIndex !== -1) {
    db.recurringPostings[pIndex] = newPosting;
  } else {
    db.recurringPostings.push(newPosting);
  }

  // Generate Bank Payment Voucher if Actual & Paid
  if (postType === 'Actual' && paymentStatus === 'Paid') {
    const { db: updatedDb2, value: vchCount } = getAndIncrementCounter(db, 'voucher', companyId);
    db = updatedDb2;
    const voucherNumber = `VCH-${vchCount}`;
    const newVoucher: Voucher = {
      id: generateId(),
      voucherNumber,
      type: 'Payment',
      date: dateStr,
      bankId,
      amount,
      description: `Payment voucher generated automatically for paid recurring expense ${expNumber}`,
      referenceType: 'Expense',
      referenceId: expenseId,
      createdById: db.currentUser.id,
      createdAt: new Date().toISOString(),
      companyId
    };
    db.vouchers.push(newVoucher);
  }


  return { db };
}

// Settle Accrual with Actual Expense
export function settleAccrualExpense(
  db: DatabaseState,
  accrualExpenseId: string,
  actualAmount: number,
  actualDate: string,
  paymentStatus: 'Paid' | 'Unpaid',
  bankId: string
): { db: DatabaseState; error?: string } {
  const accIndex = db.expenses.findIndex(e => e.id === accrualExpenseId && e.type === 'Accrual');
  if (accIndex === -1) return { db, error: 'Accrual expense not found.' };
  
  const accrualExpense = db.expenses[accIndex];
  if (accrualExpense.accrualSettled) return { db, error: 'Accrual is already settled.' };

  const companyId = accrualExpense.companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';

  // Wait, actual date must fall in current open month!
  const dateCheck = validateTransactionDate(db, actualDate, companyId);
  if (!dateCheck.valid) return { db, error: dateCheck.error };

  const { db: updatedDb1, value: expCount } = getAndIncrementCounter(db, 'expense', companyId);
  db = updatedDb1;
  const expNumber = `EXP-${expCount}`;
  const actualExpenseId = generateId();

  // Create standard Actual Expense linking back to Accrual
  const actualExpense: Expense = {
    id: actualExpenseId,
    expenseNumber: expNumber,
    date: actualDate,
    vendorId: accrualExpense.vendorId,
    taxSlabId: accrualExpense.taxSlabId,
    bankId,
    paymentStatus,
    paymentDate: paymentStatus === 'Paid' ? actualDate : null,
    description: `Accrual Settlement: Actual payment for "${accrualExpense.description}"`,
    amount: actualAmount,
    status: 'Active',
    type: 'Actual',
    originAccrualId: accrualExpenseId,
    createdById: db.currentUser.id,
    createdAt: new Date().toISOString(),
    items: [],
    companyId
  };

  db.expenses.push(actualExpense);

  // Mark Accrual as Settled
  db.expenses[accIndex].accrualSettled = true;
  db.expenses[accIndex].settledExpenseId = actualExpenseId;

  // Find corresponding posting and update status to 'Accrual Settled'
  const posting = db.recurringPostings.find(p => p.expenseId === accrualExpenseId);
  if (posting) {
    posting.status = 'Accrual Settled';
  }

  // Generate Bank Payment Voucher if Paid
  if (paymentStatus === 'Paid') {
    const { db: updatedDb2, value: vchCount } = getAndIncrementCounter(db, 'voucher', companyId);
    db = updatedDb2;
    const voucherNumber = `VCH-${vchCount}`;
    const newVoucher: Voucher = {
      id: generateId(),
      voucherNumber,
      type: 'Payment',
      date: actualDate,
      bankId,
      amount: actualAmount,
      description: `Payment voucher for actual settlement of accrual ${accrualExpense.expenseNumber}`,
      referenceType: 'Expense',
      referenceId: actualExpenseId,
      createdById: db.currentUser.id,
      createdAt: new Date().toISOString(),
      companyId
    };
    db.vouchers.push(newVoucher);
  }


  return { db };
}

// ----------------------------------------
// MONTH MANAGEMENT (Module 9)
// ----------------------------------------

// Check if all active recurring expenses are posted for the given month
export function checkRecurringPreconditions(db: DatabaseState, monthId: string, companyId?: string): { satisfied: boolean; unposted: RecurringExpenseTemplate[] } {
  const compId = companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';
  const activeTemplates = db.recurringTemplates.filter(t => t.isActive && t.companyId === compId);
  const unposted: RecurringExpenseTemplate[] = [];

  for (const template of activeTemplates) {
    const postingKey = `${template.id}_${monthId}`;
    const posting = db.recurringPostings.find(p => p.id === postingKey);
    
    if (!posting || posting.status === 'Unposted') {
      unposted.push(template);
    }
  }

  return {
    satisfied: unposted.length === 0,
    unposted
  };
}

// Calculate P&L for a specific month
export function calculateMonthPnL(db: DatabaseState, monthId: string, companyId?: string) {
  const compId = companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';
  // Revenue from invoices in this month
  const monthInvoices = db.invoices.filter(inv => inv.date.startsWith(monthId) && inv.status === 'Active' && inv.companyId === compId);
  
  // Paid revenue
  let paidRevenue = 0;
  let totalRevenue = 0;

  for (const inv of monthInvoices) {
    const totals = calculateInvoiceTotals(db, inv.items, inv.taxSlabId);
    totalRevenue += totals.grandTotal;
    if (inv.paymentStatus === 'Paid') {
      paidRevenue += totals.grandTotal;
    }
  }

  // Expenses in this month (including posted actual/accrual recurring expenses)
  const monthExpenses = db.expenses.filter(exp => exp.date.startsWith(monthId) && exp.status === 'Active' && exp.companyId === compId);
  
  let paidExpenses = 0;
  let totalExpenses = 0;

  for (const exp of monthExpenses) {
    // Note: Accrual entries are pending expenses. Let's include them in "Pending" totals, but only standard Actual (Paid) hits bank.
    totalExpenses += exp.amount;
    if (exp.paymentStatus === 'Paid') {
      paidExpenses += exp.amount;
    }
  }

  return {
    paid: {
      revenue: Number(paidRevenue.toFixed(2)),
      expenses: Number(paidExpenses.toFixed(2)),
      net: Number((paidRevenue - paidExpenses).toFixed(2))
    },
    includingPending: {
      revenue: Number(totalRevenue.toFixed(2)),
      expenses: Number(totalExpenses.toFixed(2)),
      net: Number((totalRevenue - totalExpenses).toFixed(2))
    }
  };
}

// Close current open month.
//
// NOTE: the cap-of-3-concurrently-open-months and oldest-first-close rules are enforced ONLY
// server-side, in POST /api/transactions/months (server/routes/transactions.ts). They are
// deliberately NOT re-implemented here — this codebase has already been bitten once by a
// client-side copy of a business rule silently diverging from the real server-side check
// (see BACKLOG.md item 35, the Cancel Invoice button). This function still applies the local
// in-memory status change optimistically; if the server rejects the subsequent write (see
// AdminSettings.tsx's handleConfirmClose), the caller must not treat that local mutation as
// committed. It intentionally does not know or assert anything about open-month count/order.
export function closeMonth(db: DatabaseState, monthId: string, option: 'paid_only' | 'including_pending'): { db: DatabaseState; error?: string } {
  const mIndex = db.months.findIndex(m => m.id === monthId);
  if (mIndex === -1) return { db, error: 'Month not found.' };

  const month = db.months[mIndex];
  if (month.status === 'Closed') return { db, error: 'Month is already closed.' };

  const companyId = month.companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';

  // Check recurring expenses precondition
  const recurringCheck = checkRecurringPreconditions(db, monthId, companyId);
  if (!recurringCheck.satisfied) {
    const list = recurringCheck.unposted.map(t => t.description).join(', ');
    return {
      db,
      error: `Cannot close month. Unposted active recurring expenses found: [${list}]. These must be posted as Actual or Accrual first.`
    };
  }

  const pnlResult = calculateMonthPnL(db, monthId, companyId);
  const chosenPnL = option === 'paid_only' ? pnlResult.paid : pnlResult.includingPending;

  // Mark Closed
  db.months[mIndex] = {
    ...month,
    status: 'Closed',
    closedAt: new Date().toISOString(),
    closedOption: option,
    closedPnL: {
      totalRevenue: chosenPnL.revenue,
      totalExpenses: chosenPnL.expenses,
      netProfit: chosenPnL.net
    }
  };


  return { db };
}

// Open new fiscal month. New months are opened by Admin.
//
// NOTE: the cap-of-3-concurrently-open-months rule is enforced ONLY server-side, in
// POST /api/transactions/months (server/routes/transactions.ts) — deliberately not duplicated
// here (see the comment on closeMonth above for why). The "does this exact YYYY-MM row already
// exist" check below is not a business rule with cap/ordering semantics, just a plain identity
// check — it stays as a client-side pre-check for fast feedback, but the server route also
// rejects a duplicate defensively rather than relying on the client to have caught it.
export function openNewMonth(db: DatabaseState, yearStr: string, monthStr: string, companyId?: string): { db: DatabaseState; error?: string } {
  const compId = companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';
  const monthId = `${yearStr}-${monthStr}`;
  const exists = db.months.find(m => m.id === monthId && m.companyId === compId);
  if (exists) {
    return { db, error: `Month ${monthId} already exists (status: ${exists.status}) for this company.` };
  }

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const idx = parseInt(monthStr, 10) - 1;
  const name = `${monthNames[idx]} ${yearStr}`;

  const newMonth: FiscalMonth = {
    id: monthId,
    name,
    status: 'Open',
    companyId: compId
  };

  db.months.push(newMonth);

  return { db };
}

// ----------------------------------------
// INVESTOR & EQUITY CAPITAL MANAGEMENT
// ----------------------------------------

export function saveInvestor(db: DatabaseState, investorData: Omit<Investor, 'id' | 'capitalContributed' | 'createdAt'>): { db: DatabaseState; error?: string } {
  if (!investorData.name.trim()) return { db, error: 'Investor name is required.' };
  
  const companyId = investorData.companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';
  const newInvestor: Investor = {
    ...investorData,
    companyId,
    id: generateId(),
    capitalContributed: 0,
    createdAt: new Date().toISOString()
  };

  db.investors.push(newInvestor);

  return { db };
}

export function saveCapitalInvestment(
  db: DatabaseState,
  investorId: string,
  bankId: string,
  amount: number,
  dateStr: string,
  description: string
): { db: DatabaseState; error?: string } {
  const investor = db.investors.find(i => i.id === investorId);
  if (!investor) return { db, error: 'Selected investor not found.' };

  const companyId = investor.companyId || db.selectedCompanyId || '019fa55c-622a-7cd5-b949-e61689455b41';

  const dateCheck = validateTransactionDate(db, dateStr, companyId);
  if (!dateCheck.valid) return { db, error: dateCheck.error };

  if (amount <= 0) return { db, error: 'Investment amount must be greater than zero.' };

  const bank = db.banks.find(b => b.id === bankId && b.isActive);
  if (!bank) return { db, error: 'Active bank account not found.' };

  // Create Capital Contribution Voucher (type 'Receipt', referenceType 'Equity')
  const { db: updatedDb, value: vchCount } = getAndIncrementCounter(db, 'voucher', companyId);
  db = updatedDb;
  const voucherNumber = `VCH-${vchCount}`;
  const newVoucher: Voucher = {
    id: generateId(),
    voucherNumber,
    type: 'Receipt',
    date: dateStr,
    bankId,
    amount,
    description: `Equity Capital contribution from investor ${investor.name}: ${description}`,
    referenceType: 'Equity',
    referenceId: investorId,
    createdById: db.currentUser.id,
    createdAt: new Date().toISOString(),
    companyId
  };

  // Add voucher
  db.vouchers.push(newVoucher);

  // Update investor's running capital contributed total
  investor.capitalContributed = (investor.capitalContributed || 0) + amount;


  return { db };
}


// ensure translation seed array exports are used for defaults
