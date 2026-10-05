import { getTableColumns, sql } from 'drizzle-orm';
import * as schema from './schema.js';

// Column projection for every invoice read that feeds a list/screen (GET /api/state, GET
// /api/transactions/invoices). Leaves out `xml_content` — the signed ZATCA UBL document,
// ~17 KB per invoice — and substitutes a `hasXml` flag instead, computed in SQL so the
// Postgres executor never has to detoast the value just to answer "is there one?". The XML
// is fetched on demand via GET /api/transactions/invoices/:id/xml (InvoiceViewScreen's
// "View XML" / "Download XML" buttons are its only consumers). `.select()` with no argument
// would ship every column, which for 500 invoices was ~8.8 MB of XML nobody was reading.
const { xmlContent: _omitXml, xmlContentZ: _omitXmlZ, ...invoiceColumnsWithoutXml } = getTableColumns(schema.invoices);

export const invoiceListColumns = {
  ...invoiceColumnsWithoutXml,
  hasXml: sql<boolean>`(${schema.invoices.xmlContent} is not null or ${schema.invoices.xmlContentZ} is not null)`.as('has_xml'),
};
