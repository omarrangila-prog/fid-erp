import { NextResponse } from 'next/server';
import { requirePermission, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { toErrorResponse, NotFoundError } from '@/lib/errors';
import { prisma } from '@/lib/db';
import {
  buildWorkbook,
  buildStatementWorkbook,
  buildCsv,
  workbookFileName,
  type StatementRow,
} from '@/lib/services/workbook';
import { getLoadingSheet } from '@/lib/services/loading-sheet';
import { getReceivables, getPayables } from '@/lib/services/receivables';
import { getBatchStock, getStockAgeing, getInventoryValuation } from '@/lib/services/stock';
import {
  getTrialBalanceReport,
  getProfitAndLoss,
  getBalanceSheet,
  getCashFlow,
  getGeneralLedger,
  getJournalReport,
  getExpenseReport,
  getFinancialPosition,
  getForexGainLoss,
  type ExpenseGrouping,
  type PnlLine,
} from '@/lib/services/reports';
import { getAgentCommissionRegister } from '@/lib/services/agent-commission';
import { getTaxReturn } from '@/lib/services/tax-return';
import { reconcile } from '@/lib/services/reconciliation';
import { getCustomerLedger, getVendorLedger, ledgerKindToSourceType, resolvePartyLedgerQuery } from '@/lib/services/ledger';
import {
  getShipmentProfitability,
  getCustomerProfitability,
  getProductProfitability,
  getBatchProfitability,
  getContainerProfitability,
  getMonthlyProfitability,
  getCompanyProfitSummary,
  getCogsReport,
} from '@/lib/services/profitability';
import type { SessionUser } from '@/lib/auth/session';

/**
 * Excel export.
 *
 * Server-side, because a genuine .xlsx is a zip of XML and the browser has no
 * business assembling one — and because the export should carry the same
 * figures the report does, from the same services, rather than scraping
 * whatever happens to be rendered.
 *
 * Every export re-reads the active company from the session, so a report
 * belonging to the other company cannot be pulled by changing the URL.
 */

type Report = {
  title: string;
  permission: string;
  build: (user: SessionUser, query: URLSearchParams) => Promise<Buffer>;
  csv?: (user: SessionUser, query: URLSearchParams) => Promise<{ headers: string[]; rows: Array<Array<string | number | null | undefined>> }>;
};

/**
 * The export must show what the report showed.
 *
 * A report is read on screen with a period chosen, and the Excel button sits
 * next to it. If the export quietly ignored that period and returned the year
 * to date, the client would email a spreadsheet that disagrees with the screen
 * it was taken from — and would have no way of telling which was right. So the
 * filters travel with the link, and the same defaults are applied here as
 * there when a filter is absent.
 */
function dateParam(query: URLSearchParams, key: string): Date | undefined {
  const raw = query.get(key);
  if (!raw) return undefined;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

const startOfYear = () => new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));

/** A period as the reports state it, for the line under the title. */
const period = (from: Date, to: Date) => `${asDay(from)} to ${asDay(to)}`;
const asAt = (date: Date) => `as at ${asDay(date)}`;

function asDay(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

async function customerLedgerExport(user: SessionUser, query: URLSearchParams) {
  const customerId = query.get('customer');
  if (!customerId) throw new NotFoundError('Customer');

  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId: user.activeCompany.id },
    select: { customerName: true, customerCode: true, primaryCurrency: true },
  });
  if (!customer) throw new NotFoundError('Customer');

  const resolved = resolvePartyLedgerQuery({
    view: query.get('view') ?? undefined,
    currency: query.get('currency') ?? undefined,
    localCurrency: user.activeCompany.localCurrency,
    partyCurrency: customer.primaryCurrency,
  });
  const from = dateParam(query, 'from');
  const to = dateParam(query, 'to');
  const ledger = await getCustomerLedger({
    companyId: user.activeCompany.id,
    customerId,
    view: resolved.view,
    currency: resolved.currency,
    localCurrency: user.activeCompany.localCurrency,
    partyCurrency: customer.primaryCurrency,
    from,
    to,
    sourceType: ledgerKindToSourceType(query.get('kind')),
  });

  const headers = ['Date', 'Voucher', 'Type', 'Reference', 'Description', 'Debit', 'Credit', 'Balance', 'Currency'];
  const rows: Array<Array<string | number | null | undefined>> = [
    ['', '', '', '', 'Opening balance', '', '', Number(ledger.openingBalance), ledger.viewCurrency],
    ...ledger.rows.map((row) => [
      asDay(row.entryDate),
      row.entryNumber,
      row.sourceType.replaceAll('_', ' '),
      row.reference,
      row.description,
      Number(row.debit),
      Number(row.credit),
      Number(row.balance),
      row.currency,
    ]),
    ['', '', '', '', 'Closing balance', Number(ledger.totalDebit), Number(ledger.totalCredit), Number(ledger.closingBalance), ledger.viewCurrency],
  ];

  return { customer, ledger, headers, rows, from, to, view: resolved.view };
}

async function vendorLedgerExport(user: SessionUser, query: URLSearchParams) {
  const vendorId = query.get('vendor');
  if (!vendorId) throw new NotFoundError('Supplier');

  const vendor = await prisma.vendor.findFirst({
    where: { id: vendorId, companyId: user.activeCompany.id },
    select: { vendorName: true, vendorCode: true, primaryCurrency: true },
  });
  if (!vendor) throw new NotFoundError('Supplier');

  const resolved = resolvePartyLedgerQuery({
    view: query.get('view') ?? undefined,
    currency: query.get('currency') ?? undefined,
    localCurrency: user.activeCompany.localCurrency,
    partyCurrency: vendor.primaryCurrency,
  });
  const from = dateParam(query, 'from');
  const to = dateParam(query, 'to');
  const ledger = await getVendorLedger({
    companyId: user.activeCompany.id,
    vendorId,
    view: resolved.view,
    currency: resolved.currency,
    localCurrency: user.activeCompany.localCurrency,
    partyCurrency: vendor.primaryCurrency,
    from,
    to,
    sourceType: ledgerKindToSourceType(query.get('kind'), 'vendor'),
  });

  const headers = ['Date', 'Voucher', 'Type', 'Reference', 'Description', 'Debit', 'Credit', 'Balance', 'Currency'];
  const rows: Array<Array<string | number | null | undefined>> = [
    ['', '', '', '', 'Opening balance', '', '', Number(ledger.openingBalance), ledger.viewCurrency],
    ...ledger.rows.map((row) => [
      asDay(row.entryDate),
      row.entryNumber,
      row.sourceType.replaceAll('_', ' '),
      row.reference,
      row.description,
      Number(row.debit),
      Number(row.credit),
      Number(row.balance),
      row.currency,
    ]),
    ['', '', '', '', 'Closing balance', Number(ledger.totalDebit), Number(ledger.totalCredit), Number(ledger.closingBalance), ledger.viewCurrency],
  ];

  return { vendor, ledger, headers, rows, from, to, view: resolved.view };
}

/** Statement rows for one block of a two-currency financial statement. */
function pnlSection(title: string, lines: PnlLine[], total: { usd: unknown; local: unknown }): StatementRow[] {
  return [
    { kind: 'section', label: title },
    ...lines.map((line): StatementRow => ({
      kind: 'line',
      label: line.name,
      code: line.code,
      values: [Number(line.amountUsd), Number(line.amountLocal)],
    })),
    { kind: 'total', label: `Total ${title.toLowerCase()}`, values: [Number(total.usd), Number(total.local)] },
    { kind: 'spacer' },
  ];
}

const REPORTS: Record<string, Report> = {
  'loading-sheet': {
    title: 'Loading Follow-Up',
    permission: PERMISSIONS.SHIPMENTS_VIEW,
    build: async (user) => {
      const rows = await getLoadingSheet(user.activeCompany.id);
      const isDubai = user.activeCompany.localCurrency === 'AED';

      const moroccoColumns = [
        { header: 'Contract ref', value: (r: (typeof rows)[number]) => r.contractReference },
        { header: 'FID number', value: (r: (typeof rows)[number]) => r.contractNumber },
        { header: 'Exporter', value: (r: (typeof rows)[number]) => r.exporter },
        { header: 'Importer', value: (r: (typeof rows)[number]) => r.importer },
        {
          header: 'Item',
          value: (r: (typeof rows)[number]) =>
            r.lines.map((line) => `${line.itemName} (${Number(line.quantityKg)} KG)`).join('; '),
          width: 42,
        },
        { header: 'Quantity (KG)', value: (r: (typeof rows)[number]) => Number(r.quantityKg), type: 'quantity' as const },
        { header: 'Containers', value: (r: (typeof rows)[number]) => r.containers, type: 'integer' as const },
        { header: 'Status', value: (r: (typeof rows)[number]) => r.status.replace(/_/g, ' ') },
        { header: 'Shipping line', value: (r: (typeof rows)[number]) => r.shippingLine ?? '' },
        {
          header: 'Booking / B/L',
          value: (r: (typeof rows)[number]) => [r.bookingNumber, r.billOfLading].filter(Boolean).join(' · '),
        },
        { header: 'Container no.', value: (r: (typeof rows)[number]) => r.containerNumbers.join(', ') },
        { header: 'ETA', value: (r: (typeof rows)[number]) => r.etaDate ?? '', type: 'date' as const },
      ];

      const dubaiColumns = [
        { header: 'Contract date', value: (r: (typeof rows)[number]) => r.contractDate, type: 'date' as const },
        { header: 'Contract ref', value: (r: (typeof rows)[number]) => r.contractReference },
        { header: 'FID number', value: (r: (typeof rows)[number]) => r.contractNumber },
        { header: 'Exporter', value: (r: (typeof rows)[number]) => r.exporter },
        { header: 'Importer', value: (r: (typeof rows)[number]) => r.importer },
        { header: 'Consignee', value: (r: (typeof rows)[number]) => r.consignee ?? '' },
        {
          header: 'Items description',
          value: (r: (typeof rows)[number]) =>
            r.lines.map((line) => `${line.itemName} (${Number(line.quantityKg)} KG)`).join('; '),
          width: 42,
        },
        { header: 'Quantity (KG)', value: (r: (typeof rows)[number]) => Number(r.quantityKg), type: 'quantity' as const },
        { header: 'Sold (KG)', value: (r: (typeof rows)[number]) => Number(r.soldKg), type: 'quantity' as const },
        { header: 'Available (KG)', value: (r: (typeof rows)[number]) => Number(r.availableKg), type: 'quantity' as const },
        { header: 'Origin', value: (r: (typeof rows)[number]) => r.origin },
        { header: 'Destination', value: (r: (typeof rows)[number]) => r.destination ?? '' },
        { header: 'Status', value: (r: (typeof rows)[number]) => r.status.replace(/_/g, ' ') },
        { header: 'Containers', value: (r: (typeof rows)[number]) => r.containers, type: 'integer' as const },
        { header: 'Container no.', value: (r: (typeof rows)[number]) => r.containerNumbers.join(', ') },
        { header: 'B/L', value: (r: (typeof rows)[number]) => r.billOfLading ?? '' },
        { header: 'Shipping line', value: (r: (typeof rows)[number]) => r.shippingLine ?? '' },
        { header: 'Booking no.', value: (r: (typeof rows)[number]) => r.bookingNumber ?? '' },
        { header: 'Port of loading', value: (r: (typeof rows)[number]) => r.portOfLoading ?? '' },
        { header: 'Port of discharge', value: (r: (typeof rows)[number]) => r.portOfDischarge ?? '' },
        { header: 'ETA', value: (r: (typeof rows)[number]) => r.etaDate ?? '', type: 'date' as const },
        { header: 'Sale status', value: (r: (typeof rows)[number]) => r.saleStatus.replace(/_/g, ' ') },
        { header: 'Payment', value: (r: (typeof rows)[number]) => (r.paymentStatus === 'NONE' ? '' : r.paymentStatus) },
        { header: 'Documents', value: (r: (typeof rows)[number]) => r.documentStatus.replace(/_/g, ' ') },
        { header: 'Remarks', value: (r: (typeof rows)[number]) => r.remarks ?? '', width: 32 },
      ];

      return buildWorkbook({
        companyName: user.activeCompany.name,
        title: 'Loading Follow-Up',
        subtitle: `${rows.length} shipment${rows.length === 1 ? '' : 's'} on the book`,
        rows,
        totals: isDubai ? ['Quantity (KG)', 'Sold (KG)', 'Available (KG)'] : ['Quantity (KG)'],
        columns: isDubai ? dubaiColumns : moroccoColumns,
      });
    },
  },

  allocations: {
    title: 'Stock Allocation',
    permission: PERMISSIONS.INVENTORY_VIEW,
    build: async (user) => {
      const sheet = await getLoadingSheet(user.activeCompany.id);

      // One row per customer allocation, plus a row for anything unsold, so
      // the sheet totals back to what was purchased.
      const itemLabel = (row: (typeof sheet)[number]) => row.lines.map((line) => line.itemName).join('; ');
      const batchLabel = (row: (typeof sheet)[number]) =>
        row.lines.map((line) => line.batchNumber).filter(Boolean).join(', ');

      const rows = sheet.flatMap((row) =>
        row.allocations.length === 0
          ? [{
              contractReference: row.contractReference,
              contractNumber: row.contractNumber,
              batchNumber: batchLabel(row),
              itemName: itemLabel(row),
              purchased: Number(row.quantityKg),
              customerName: '— unsold —',
              invoiceNumber: '',
              invoiceDate: null as Date | null,
              quantity: 0,
              value: 0,
              currency: '',
              outstanding: 0,
              settlement: '',
              available: Number(row.availableKg),
            }]
          : row.allocations.map((allocation) => ({
              contractReference: row.contractReference,
              contractNumber: row.contractNumber,
              batchNumber: batchLabel(row),
              itemName: itemLabel(row),
              purchased: Number(row.quantityKg),
              customerName: allocation.customerName,
              invoiceNumber: allocation.invoiceNumber,
              invoiceDate: allocation.invoiceDate as Date | null,
              quantity: Number(allocation.quantityKg),
              value: Number(allocation.amount),
              currency: allocation.currency,
              outstanding: Number(allocation.outstanding),
              settlement: allocation.settlement,
              available: Number(row.availableKg),
            })),
      );

      return buildWorkbook({
        companyName: user.activeCompany.name,
        title: 'Stock Allocation',
        subtitle: 'Each purchase and every customer it was sold to',
        rows,
        totals: ['Sold (KG)', 'Value', 'Outstanding'],
        columns: [
          { header: 'Contract ref', value: (r) => r.contractReference },
          { header: 'FID number', value: (r) => r.contractNumber },
          { header: 'Batch', value: (r) => r.batchNumber },
          { header: 'Coffee', value: (r) => r.itemName, width: 34 },
          { header: 'Purchased (KG)', value: (r) => r.purchased, type: 'quantity' },
          { header: 'Customer', value: (r) => r.customerName, width: 30 },
          { header: 'Invoice', value: (r) => r.invoiceNumber },
          { header: 'Invoice date', value: (r) => r.invoiceDate, type: 'date' },
          { header: 'Sold (KG)', value: (r) => r.quantity, type: 'quantity' },
          { header: 'Currency', value: (r) => r.currency, width: 10 },
          { header: 'Value', value: (r) => r.value, type: 'money' },
          { header: 'Outstanding', value: (r) => r.outstanding, type: 'money' },
          { header: 'Payment', value: (r) => r.settlement },
          { header: 'Available (KG)', value: (r) => r.available, type: 'quantity' },
        ],
      });
    },
  },

  receivables: {
    title: 'Customer Receivables',
    permission: PERMISSIONS.RECEIVABLES_VIEW,
    build: async (user) => {
      const rows = await getReceivables({ companyId: user.activeCompany.id, onlyOutstanding: true });
      return buildWorkbook({
        companyName: user.activeCompany.name,
        title: 'Customer Receivables',
        subtitle: 'Outstanding invoices, oldest first',
        rows,
        totals: ['Invoice total', 'Received', 'Outstanding', 'Outstanding (USD)'],
        columns: [
          { header: 'Invoice', value: (r) => r.invoiceNumber },
          { header: 'Date', value: (r) => r.invoiceDate, type: 'date' },
          { header: 'Due', value: (r) => r.dueDate, type: 'date' },
          { header: 'Customer', value: (r) => r.customerName, width: 32 },
          { header: 'Currency', value: (r) => r.currency, width: 10 },
          { header: 'Invoice total', value: (r) => Number(r.originalAmount), type: 'money' },
          { header: 'Received', value: (r) => Number(r.paidAmount), type: 'money' },
          { header: 'Outstanding', value: (r) => Number(r.outstandingAmount), type: 'money' },
          { header: 'Outstanding (USD)', value: (r) => Number(r.outstandingAmountUsd), type: 'money' },
          { header: 'Age', value: (r) => r.bucket.replace(/_/g, ' ') },
          { header: 'Status', value: (r) => r.status },
        ],
      });
    },
  },

  payables: {
    title: 'Supplier Payables',
    permission: PERMISSIONS.PAYABLES_VIEW,
    build: async (user) => {
      const rows = await getPayables({ companyId: user.activeCompany.id, onlyOutstanding: true });
      return buildWorkbook({
        companyName: user.activeCompany.name,
        title: 'Supplier Payables',
        subtitle: 'Outstanding contracts, oldest first',
        rows,
        totals: ['Contract value', 'Paid', 'Outstanding', 'Outstanding (USD)'],
        columns: [
          { header: 'Contract', value: (r) => r.contractNumber },
          { header: 'Supplier ref', value: (r) => r.contractReference },
          { header: 'Date', value: (r) => r.contractDate, type: 'date' },
          { header: 'Due', value: (r) => r.dueDate, type: 'date' },
          { header: 'Supplier', value: (r) => r.vendorName, width: 32 },
          { header: 'Currency', value: (r) => r.currency, width: 10 },
          { header: 'Contract value', value: (r) => Number(r.purchaseValue), type: 'money' },
          { header: 'Paid', value: (r) => Number(r.paidAmount), type: 'money' },
          { header: 'Outstanding', value: (r) => Number(r.outstandingAmount), type: 'money' },
          { header: 'Outstanding (USD)', value: (r) => Number(r.outstandingAmountUsd), type: 'money' },
          { header: 'Age', value: (r) => r.bucket.replace(/_/g, ' ') },
          { header: 'Status', value: (r) => r.status },
        ],
      });
    },
  },

  'stock-on-hand': {
    title: 'Stock on Hand',
    permission: PERMISSIONS.INVENTORY_VIEW,
    build: async (user) => {
      const rows = await getBatchStock({ companyId: user.activeCompany.id });
      return buildWorkbook({
        companyName: user.activeCompany.name,
        title: 'Stock on Hand',
        subtitle: 'Every batch in every warehouse',
        rows,
        totals: ['Received (KG)', 'Sold (KG)', 'Available (KG)', 'Value (USD)'],
        columns: [
          { header: 'Warehouse', value: (r) => r.warehouseNames, width: 28 },
          { header: 'Coffee', value: (r) => r.itemName, width: 34 },
          { header: 'Lot', value: (r) => r.lotNumber },
          { header: 'Batch', value: (r) => r.batchNumber },
          { header: 'Container', value: (r) => r.containerNumber ?? '' },
          { header: 'Supplier', value: (r) => r.vendorName, width: 28 },
          { header: 'Received (KG)', value: (r) => Number(r.receivedKg), type: 'quantity' },
          { header: 'Sold (KG)', value: (r) => Number(r.soldKg), type: 'quantity' },
          { header: 'Reserved (KG)', value: (r) => Number(r.allocatedKg), type: 'quantity' },
          { header: 'Available (KG)', value: (r) => Number(r.availableKg), type: 'quantity' },
          { header: 'In transit (KG)', value: (r) => Number(r.inTransitKg), type: 'quantity' },
          { header: 'Cost/KG (USD)', value: (r) => Number(r.unitCostUsd), type: 'number' },
          { header: 'Value (USD)', value: (r) => Number(r.stockValueUsd), type: 'money' },
        ],
      });
    },
  },

  'stock-ageing': {
    title: 'Stock Ageing',
    permission: PERMISSIONS.INVENTORY_VIEW,
    build: async (user) => {
      const rows = await getStockAgeing(user.activeCompany.id);
      return buildWorkbook({
        companyName: user.activeCompany.name,
        title: 'Stock Ageing',
        subtitle: 'How long each parcel has been in the warehouse, oldest first',
        rows,
        totals: ['On hand (KG)', 'Reserved (KG)', 'Available (KG)', 'Value (USD)'],
        columns: [
          { header: 'Batch', value: (r) => r.batchNumber },
          { header: 'Lot', value: (r) => r.lotNumber },
          { header: 'Container', value: (r) => r.containerNumber ?? '' },
          { header: 'Coffee', value: (r) => r.itemName, width: 34 },
          { header: 'Origin', value: (r) => r.originCountry },
          { header: 'Warehouse', value: (r) => r.warehouseName, width: 26 },
          { header: 'Received', value: (r) => r.receivedAt, type: 'date' },
          { header: 'Days in stock', value: (r) => r.daysInStock ?? 0, type: 'integer' },
          { header: 'Age', value: (r) => r.bucket },
          { header: 'On hand (KG)', value: (r) => Number(r.onHandKg), type: 'quantity' },
          { header: 'Reserved (KG)', value: (r) => Number(r.reservedKg), type: 'quantity' },
          { header: 'Available (KG)', value: (r) => Number(r.availableKg), type: 'quantity' },
          { header: 'Cost/KG (USD)', value: (r) => Number(r.unitCostUsd), type: 'number' },
          { header: 'Value (USD)', value: (r) => Number(r.valueUsd), type: 'money' },
        ],
      });
    },
  },

  profitability: {
    title: 'Profitability',
    permission: PERMISSIONS.PROFITS_VIEW,
    build: async (user, query) => {
      const companyId = user.activeCompany.id;
      const view = query.get('view') ?? 'shipment';
      const summary = await getCompanyProfitSummary({ companyId });

      if (view === 'customer' || view === 'product' || view === 'batch' || view === 'container') {
        const rows =
          view === 'customer'
            ? await getCustomerProfitability({ companyId })
            : view === 'product'
              ? await getProductProfitability({ companyId })
              : view === 'batch'
                ? await getBatchProfitability({ companyId })
                : await getContainerProfitability({ companyId });
        const titles = { customer: 'Customer', product: 'Coffee', batch: 'Batch', container: 'Container' } as const;
        return buildWorkbook({
          companyName: user.activeCompany.name,
          title: 'Profitability',
          subtitle: `By ${titles[view].toLowerCase()} · gross profit USD ${Number(summary.grossProfitUsd).toFixed(2)}`,
          rows,
          totals: ['Quantity (KG)', 'Revenue (USD)', 'Cost (USD)', 'Gross profit (USD)'],
          columns: [
            { header: titles[view], value: (r) => r.label, width: 32 },
            { header: 'Detail', value: (r) => r.sublabel ?? '' },
            { header: 'Quantity (KG)', value: (r) => Number(r.quantityKg), type: 'quantity' },
            { header: 'Revenue (USD)', value: (r) => Number(r.revenueUsd), type: 'money' },
            { header: 'Cost (USD)', value: (r) => Number(r.cogsUsd), type: 'money' },
            { header: 'Gross profit (USD)', value: (r) => Number(r.grossProfitUsd), type: 'money' },
            { header: 'Per KG (USD)', value: (r) => Number(r.profitPerKgUsd), type: 'money' },
            { header: 'Margin', value: (r) => Number(r.grossMarginPct) / 100, type: 'percent' },
          ],
        });
      }

      if (view === 'month') {
        const rows = await getMonthlyProfitability({ companyId, months: 12 });
        return buildWorkbook({
          companyName: user.activeCompany.name,
          title: 'Profitability',
          subtitle: 'Last twelve months, USD',
          rows,
          totals: ['Revenue (USD)', 'Cost of goods (USD)', 'Gross profit (USD)', 'Expenses (USD)', 'Net profit (USD)'],
          columns: [
            { header: 'Month', value: (r) => r.month },
            { header: 'Revenue (USD)', value: (r) => Number(r.revenueUsd), type: 'money' },
            { header: 'Cost of goods (USD)', value: (r) => Number(r.cogsUsd), type: 'money' },
            { header: 'Gross profit (USD)', value: (r) => Number(r.grossProfitUsd), type: 'money' },
            { header: 'Expenses (USD)', value: (r) => Number(r.expensesUsd), type: 'money' },
            { header: 'Net profit (USD)', value: (r) => Number(r.netProfitUsd), type: 'money' },
          ],
        });
      }

      const rows = await getShipmentProfitability({ companyId });
      const local = user.activeCompany.localCurrency;
      const byContract = view === 'contract';
      return buildWorkbook({
        companyName: user.activeCompany.name,
        title: 'Profitability',
        subtitle: `${byContract ? 'By contract' : 'By job'} · net profit USD ${Number(summary.netProfitUsd).toFixed(2)}`,
        rows,
        totals: ['Sold (KG)', 'Revenue (USD)', `Revenue (${local})`, 'Landed cost (USD)', 'Gross profit (USD)', 'Other costs (USD)', 'Net profit (USD)', `Net profit (${local})`],
        columns: [
          ...(byContract
            ? [
                { header: 'Contract ref', value: (r: (typeof rows)[number]) => r.contractReference, width: 22 },
                { header: 'Contract', value: (r: (typeof rows)[number]) => r.contractNumber },
                { header: 'Job', value: (r: (typeof rows)[number]) => r.jobNumber },
              ]
            : [
                { header: 'Job', value: (r: (typeof rows)[number]) => r.jobNumber },
                { header: 'Shipment', value: (r: (typeof rows)[number]) => r.shipmentNumber },
                { header: 'Contract ref', value: (r: (typeof rows)[number]) => r.contractReference, width: 22 },
              ]),
          { header: 'Coffee', value: (r) => r.itemName, width: 28 },
          { header: 'Status', value: (r) => r.status },
          { header: 'Sold (KG)', value: (r) => Number(r.soldQuantityKg), type: 'quantity' as const },
          { header: 'Remaining (KG)', value: (r) => Number(r.remainingQuantityKg), type: 'quantity' as const },
          { header: 'Revenue (USD)', value: (r) => Number(r.salesRevenueUsd), type: 'money' as const },
          { header: `Revenue (${local})`, value: (r) => Number(r.salesRevenueLocal), type: 'money' as const },
          { header: 'Landed cost (USD)', value: (r) => Number(r.allocatedLandedCostUsd), type: 'money' as const },
          { header: `Landed cost (${local})`, value: (r) => Number(r.allocatedLandedCostLocal), type: 'money' as const },
          { header: 'Gross profit (USD)', value: (r) => Number(r.grossProfitUsd), type: 'money' as const },
          { header: 'Other costs (USD)', value: (r) => Number(r.otherCostsUsd), type: 'money' as const },
          { header: 'Net profit (USD)', value: (r) => Number(r.netProfitUsd), type: 'money' as const },
          { header: `Net profit (${local})`, value: (r) => Number(r.netProfitLocal), type: 'money' as const },
          { header: 'Per KG (USD)', value: (r) => Number(r.profitPerKgUsd), type: 'money' as const },
          { header: `Per KG (${local})`, value: (r) => Number(r.profitPerKgLocal), type: 'money' as const },
          { header: 'Margin', value: (r) => Number(r.netMarginPct) / 100, type: 'percent' as const },
        ],
      });
    },
  },

  'trial-balance': {
    title: 'Trial Balance',
    permission: PERMISSIONS.ACCOUNTING_VIEW,
    build: async (user, query) => {
      const asOf = dateParam(query, 'asOf') ?? new Date();
      const local = user.activeCompany.localCurrency;
      const trial = await getTrialBalanceReport({ companyId: user.activeCompany.id, to: asOf });

      return buildWorkbook({
        companyName: user.activeCompany.name,
        title: 'Trial Balance',
        subtitle: trial.isBalanced ? asAt(asOf) : `${asAt(asOf)} — OUT OF BALANCE`,
        rows: trial.rows,
        totals: [`Debit USD`, `Credit USD`, `Debit ${local}`, `Credit ${local}`],
        columns: [
          { header: 'Account', value: (r) => r.name, width: 36 },
          { header: 'Type', value: (r) => r.type },
          { header: 'Debit USD', value: (r) => Number(r.debitUsd), type: 'money' },
          { header: 'Credit USD', value: (r) => Number(r.creditUsd), type: 'money' },
          { header: `Debit ${local}`, value: (r) => Number(r.debitLocal), type: 'money' },
          { header: `Credit ${local}`, value: (r) => Number(r.creditLocal), type: 'money' },
        ],
      });
    },
  },

  'profit-loss': {
    title: 'Profit and Loss',
    permission: PERMISSIONS.ACCOUNTING_VIEW,
    build: async (user, query) => {
      const from = dateParam(query, 'from') ?? startOfYear();
      const to = dateParam(query, 'to') ?? new Date();
      const local = user.activeCompany.localCurrency;
      const pnl = await getProfitAndLoss({ companyId: user.activeCompany.id, from, to });
      const t = pnl.totals;

      const rows: StatementRow[] = [
        ...pnlSection('Revenue', pnl.revenue, { usd: t.revenueUsd, local: t.revenueLocal }),
        ...pnlSection('Cost of sales', pnl.costOfSales, { usd: t.costOfSalesUsd, local: t.costOfSalesLocal }),
        {
          kind: 'total',
          label: 'Gross profit',
          values: [Number(t.grossProfitUsd), Number(t.grossProfitLocal)],
        },
        { kind: 'note', label: `Gross margin ${Number(pnl.grossMarginPct).toFixed(1)}% of revenue` },
        { kind: 'spacer' },
        ...pnlSection('Operating expenses', pnl.operatingExpenses, {
          usd: t.operatingExpensesUsd,
          local: t.operatingExpensesLocal,
        }),
      ];

      if (pnl.otherItems.length > 0) {
        rows.push(...pnlSection('Other income and charges', pnl.otherItems, { usd: t.otherUsd, local: t.otherLocal }));
      }

      rows.push(
        { kind: 'grand', label: 'Net profit', values: [Number(t.netProfitUsd), Number(t.netProfitLocal)] },
        { kind: 'note', label: `Net margin ${Number(pnl.netMarginPct).toFixed(1)}% of revenue` },
      );

      return buildStatementWorkbook({
        companyName: user.activeCompany.name,
        title: 'Profit and Loss',
        subtitle: period(from, to),
        labelHeader: 'Account',
        columns: [
          { header: 'USD', type: 'money' },
          { header: local, type: 'money' },
        ],
        rows,
      });
    },
  },

  'balance-sheet': {
    title: 'Balance Sheet',
    permission: PERMISSIONS.ACCOUNTING_VIEW,
    build: async (user, query) => {
      const asOf = dateParam(query, 'asOf') ?? new Date();
      const local = user.activeCompany.localCurrency;
      const sheet = await getBalanceSheet({ companyId: user.activeCompany.id, asOf });

      const rows: StatementRow[] = [
        ...pnlSection('Assets', sheet.assets.lines, { usd: sheet.assets.totalUsd, local: sheet.assets.totalLocal }),
        ...pnlSection('Liabilities', sheet.liabilities.lines, {
          usd: sheet.liabilities.totalUsd,
          local: sheet.liabilities.totalLocal,
        }),
        ...pnlSection('Equity', sheet.equity.lines, { usd: sheet.equity.totalUsd, local: sheet.equity.totalLocal }),
        {
          kind: 'grand',
          label: 'Liabilities and equity',
          values: [
            Number(sheet.liabilities.totalUsd) + Number(sheet.equity.totalUsd),
            Number(sheet.liabilities.totalLocal) + Number(sheet.equity.totalLocal),
          ],
        },
      ];

      // Say so on the sheet itself. A balance sheet that does not balance is
      // the one thing a reader must not have to work out for themselves.
      rows.push({
        kind: 'note',
        label: sheet.balancesUsd
          ? 'Assets equal liabilities plus equity.'
          : `OUT OF BALANCE by USD ${Number(sheet.differenceUsd).toFixed(2)} — this needs investigating.`,
      });

      return buildStatementWorkbook({
        companyName: user.activeCompany.name,
        title: 'Balance Sheet',
        subtitle: asAt(asOf),
        labelHeader: 'Account',
        columns: [
          { header: 'USD', type: 'money' },
          { header: local, type: 'money' },
        ],
        rows,
      });
    },
  },

  'cash-flow': {
    title: 'Cash Flow',
    permission: PERMISSIONS.CASHBANK_VIEW,
    build: async (user, query) => {
      const from = dateParam(query, 'from') ?? startOfYear();
      const to = dateParam(query, 'to') ?? new Date();
      const flow = await getCashFlow({ companyId: user.activeCompany.id, from, to });

      return buildStatementWorkbook({
        companyName: user.activeCompany.name,
        title: 'Cash Flow',
        subtitle: period(from, to),
        labelHeader: 'Movement',
        columns: [
          { header: 'In USD', type: 'money' },
          { header: 'Out USD', type: 'money' },
          { header: 'Net USD', type: 'money' },
        ],
        rows: [
          { kind: 'section', label: 'Money in and out of cash and bank' },
          ...flow.lines.map((line): StatementRow => ({
            kind: 'line',
            label: line.label,
            values: [Number(line.inUsd), Number(line.outUsd), Number(line.netUsd)],
          })),
          {
            kind: 'grand',
            label: 'Net movement',
            values: [Number(flow.totalInUsd), Number(flow.totalOutUsd), Number(flow.netMovementUsd)],
          },
          { kind: 'note', label: 'Direct method: what actually moved through cash and bank, grouped by cause.' },
        ],
      });
    },
  },

  'general-ledger': {
    title: 'General Ledger',
    permission: PERMISSIONS.ACCOUNTING_VIEW,
    build: async (user, query) => {
      const companyId = user.activeCompany.id;
      const requested = query.get('account');

      // The page falls back to the first account when none is chosen. The
      // export has to make the same choice, or the button would fail on a
      // screen that is showing something perfectly well.
      const account = requested
        ? await prisma.account.findFirst({ where: { id: requested, companyId }, select: { id: true } })
        : await prisma.account.findFirst({ where: { companyId }, orderBy: { code: 'asc' }, select: { id: true } });

      if (!account) throw new NotFoundError('Account');

      const ledger = await getGeneralLedger({
        companyId,
        accountId: account.id,
        from: dateParam(query, 'from'),
        to: dateParam(query, 'to'),
        currency: query.get('currency') || undefined,
      });

      return buildWorkbook({
        companyName: user.activeCompany.name,
        title: 'General Ledger',
        subtitle:
          `${ledger.account.name} · opening USD ${Number(ledger.openingBalanceUsd).toFixed(2)}` +
          ` · closing USD ${Number(ledger.closingBalanceUsd).toFixed(2)}`,
        rows: ledger.rows,
        totals: ['Debit USD', 'Credit USD'],
        columns: [
          { header: 'Date', value: (r) => r.entryDate, type: 'date' },
          { header: 'Entry', value: (r) => r.entryNumber },
          { header: 'Source', value: (r) => r.sourceType.replace(/_/g, ' ') },
          { header: 'Description', value: (r) => r.description, width: 40 },
          { header: 'Reference', value: (r) => r.reference ?? '', width: 28 },
          { header: 'Currency', value: (r) => r.currency, width: 10 },
          { header: 'Debit', value: (r) => Number(r.debit), type: 'money' },
          { header: 'Credit', value: (r) => Number(r.credit), type: 'money' },
          { header: 'Debit USD', value: (r) => Number(r.debitUsd), type: 'money' },
          { header: 'Credit USD', value: (r) => Number(r.creditUsd), type: 'money' },
          { header: 'Balance USD', value: (r) => Number(r.balanceUsd), type: 'money' },
        ],
      });
    },
  },

  journal: {
    title: 'Journal',
    permission: PERMISSIONS.ACCOUNTING_VIEW,
    build: async (user, query) => {
      const from = dateParam(query, 'from');
      const to = dateParam(query, 'to');
      const sourceType = query.get('sourceType') || undefined;

      const entries = await getJournalReport({
        companyId: user.activeCompany.id,
        from,
        to,
        sourceType,
        limit: 5000,
      });

      // One row per line, not per entry: a journal read in a spreadsheet is
      // read by filtering on an account, and that only works if the account is
      // on the row. The entry number repeats down the group, which is how the
      // reader sees both sides of the same posting.
      const rows = entries.flatMap((entry) =>
        entry.lines.map((line) => ({
          entryNumber: entry.entryNumber,
          entryDate: entry.entryDate,
          sourceType: entry.sourceType as string,
          narration: entry.description,
          createdBy: entry.createdBy?.name ?? '',
          accountCode: line.account.code,
          accountName: line.account.name,
          lineDescription: line.description ?? '',
          debitUsd: Number(line.debitUsd),
          creditUsd: Number(line.creditUsd),
        })),
      );

      return buildWorkbook({
        companyName: user.activeCompany.name,
        title: 'Journal',
        subtitle:
          (from && to ? `${period(from, to)} · ` : '') +
          `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, ${rows.length} lines`,
        rows,
        totals: ['Debit USD', 'Credit USD'],
        columns: [
          { header: 'Date', value: (r) => r.entryDate, type: 'date' },
          { header: 'Entry', value: (r) => r.entryNumber },
          { header: 'Source', value: (r) => r.sourceType.replace(/_/g, ' ') },
          { header: 'Narration', value: (r) => r.narration, width: 38 },
          { header: 'Account', value: (r) => r.accountName, width: 32 },
          { header: 'Line detail', value: (r) => r.lineDescription, width: 32 },
          { header: 'Debit USD', value: (r) => r.debitUsd, type: 'money' },
          { header: 'Credit USD', value: (r) => r.creditUsd, type: 'money' },
          { header: 'Entered by', value: (r) => r.createdBy },
        ],
      });
    },
  },

  expenses: {
    title: 'Expense Report',
    permission: PERMISSIONS.EXPENSES_VIEW,
    build: async (user, query) => {
      const from = dateParam(query, 'from') ?? startOfYear();
      const to = dateParam(query, 'to') ?? new Date();
      const allowed: ExpenseGrouping[] = ['type', 'category', 'shipment', 'payee', 'month'];
      const requested = query.get('groupBy') as ExpenseGrouping | null;
      const groupBy = requested && allowed.includes(requested) ? requested : 'type';

      const rows = await getExpenseReport({ companyId: user.activeCompany.id, from, to, groupBy });
      const total = rows.reduce((sum, row) => sum + Number(row.amountUsd), 0);

      return buildWorkbook({
        companyName: user.activeCompany.name,
        title: 'Expense Report',
        subtitle: `${period(from, to)} · grouped by ${groupBy}`,
        rows: rows.map((row) => ({
          ...row,
          share: total === 0 ? 0 : Number(row.amountUsd) / total,
        })),
        totals: ['Amount USD', 'Entries'],
        columns: [
          { header: titleFor(groupBy), value: (r) => r.label, width: 40 },
          { header: 'Entries', value: (r) => r.count, type: 'integer' },
          { header: 'Amount USD', value: (r) => Number(r.amountUsd), type: 'money' },
          { header: 'Share', value: (r) => r.share, type: 'percent' },
        ],
      });
    },
  },

  'tax-return': {
    title: 'Tax Return',
    permission: PERMISSIONS.ACCOUNTING_VIEW,
    build: async (user, query) => {
      const from = dateParam(query, 'from') ?? startOfYear();
      const to = dateParam(query, 'to') ?? new Date();
      const figures = await getTaxReturn({ companyId: user.activeCompany.id, from, to });
      const currency = figures.localCurrency;

      const band = (label: string, bands: typeof figures.sales): StatementRow[] => [
        { kind: 'section', label },
        ...bands.map((row): StatementRow => ({
          kind: 'line',
          label: `${row.label} (${row.ratePct}%)`,
          code: row.code,
          values: [row.documentCount, Number(row.netLocal), Number(row.taxLocal)],
        })),
      ];

      return buildStatementWorkbook({
        companyName: user.activeCompany.name,
        title: `${figures.label} Return`,
        subtitle:
          `${period(figures.periodStart, figures.periodEnd)}` +
          (figures.registrationNumber ? ` · registration ${figures.registrationNumber}` : ''),
        labelHeader: 'Band',
        showCodes: true,
        columns: [
          { header: 'Documents', type: 'integer' },
          { header: `Net ${currency}`, type: 'money' },
          { header: `Tax ${currency}`, type: 'money' },
        ],
        rows: [
          ...band('Sales', figures.sales),
          { kind: 'total', label: 'Output tax', values: [null, null, Number(figures.outputTax)] },
          { kind: 'spacer' },
          ...band('Purchases', figures.purchases),
          { kind: 'total', label: 'Input tax', values: [null, null, Number(figures.inputTax)] },
          { kind: 'spacer' },
          {
            kind: 'grand',
            label: Number(figures.netPayable) >= 0 ? 'Net payable to the authority' : 'Net reclaimable',
            values: [null, null, Math.abs(Number(figures.netPayable))],
          },
          { kind: 'spacer' },
          { kind: 'section', label: 'Cross-check against the control accounts' },
          {
            kind: 'line',
            label: 'Output tax per ledger',
            values: [null, null, Number(figures.ledgerOutputTax)],
          },
          {
            kind: 'line',
            label: 'Input tax per ledger',
            values: [null, null, Number(figures.ledgerInputTax)],
          },
          {
            kind: 'note',
            label: figures.reconciled
              ? 'The documents and the ledger agree.'
              : `They disagree — output by ${figures.outputDifference}, input by ${figures.inputDifference}.` +
                ' Usually a manual journal touching a tax account. Investigate before filing.',
          },
          figures.filed
            ? {
                kind: 'note',
                label: `Filed${figures.filed.reference ? ` under ${figures.filed.reference}` : ''}` +
                  `${figures.filed.filedAt ? ` on ${asDay(figures.filed.filedAt)}` : ''}.`,
              }
            : { kind: 'note', label: 'Not yet filed.' },
        ],
      });
    },
  },

  'financial-position': {
    title: 'Financial Position',
    permission: PERMISSIONS.CASHBANK_VIEW,
    build: async (user, query) => {
      const asOf = dateParam(query, 'asOf');
      const position = await getFinancialPosition({ companyId: user.activeCompany.id, asOf: asOf ?? undefined });

      // Hiding a figure on screen and then writing it into the workbook would
      // make the permission decorative. The export applies the same rule.
      const showValue = can(user, PERMISSIONS.PURCHASE_COST_VIEW);

      return buildStatementWorkbook({
        companyName: user.activeCompany.name,
        title: 'Financial Position',
        subtitle: asOf ? asAt(asOf) : 'as at today',
        labelHeader: 'Item',
        columns: [
          { header: 'Balance', type: 'money' },
          { header: 'Currency', type: 'text', width: 12 },
          { header: 'USD', type: 'money' },
        ],
        rows: [
          { kind: 'section', label: 'Cash and bank' },
          ...position.accounts.map((account): StatementRow => ({
            kind: 'line',
            label: account.name,
            values: [Number(account.balance), account.currency, Number(account.balanceUsd)],
          })),
          {
            kind: 'total',
            label: 'Total cash and bank',
            values: [null, '', position.accounts.reduce((sum, a) => sum + Number(a.balanceUsd), 0)],
          },
          { kind: 'spacer' },
          { kind: 'section', label: 'Owed to and by the business' },
          { kind: 'line', label: 'Owed by customers', values: [null, '', Number(position.receivableUsd)] },
          { kind: 'line', label: 'Owed to suppliers', values: [null, '', -Number(position.payableUsd)] },
          {
            kind: 'line',
            label: 'Cheques on hand, not yet banked',
            values: [null, '', Number(position.chequesOnHandUsd)],
          },
          { kind: 'spacer' },
          { kind: 'section', label: 'Coffee' },
          {
            kind: 'line',
            label: `In the warehouse (${Number(position.availableKg).toFixed(3)} KG, ${position.bags} bags)`,
            values: [null, '', showValue ? Number(position.inventoryValueUsd) : null],
          },
          {
            kind: 'line',
            label: `On the water (${Number(position.inTransitKg).toFixed(3)} KG)`,
            values: [null, '', showValue ? Number(position.inTransitValueUsd) : null],
          },
          {
            kind: 'note',
            label: showValue
              ? 'Stock is valued at landed cost, not at what it is expected to sell for.'
              : 'Stock quantities only. Cost figures are not part of your access.',
          },
        ],
      });
    },
  },

  reconciliation: {
    title: 'Reconciliation',
    permission: PERMISSIONS.ACCOUNTING_VIEW,
    build: async (user) => {
      const result = await reconcile(user.activeCompany.id);

      return buildWorkbook({
        companyName: user.activeCompany.name,
        title: 'Reconciliation',
        subtitle: result.healthy
          ? `All ${result.passed} checks agree`
          : `${result.failed} of ${result.passed + result.failed} checks disagree`,
        rows: result.checks,
        columns: [
          { header: 'Result', value: (r) => (r.passed ? 'Agrees' : 'DISAGREES'), width: 12 },
          { header: 'Group', value: (r) => r.group },
          { header: 'Check', value: (r) => r.label, width: 40 },
          { header: 'What it compares', value: (r) => r.explanation, width: 52 },
          { header: 'Left', value: (r) => r.left.label, width: 28 },
          { header: 'Left value', value: (r) => Number(r.left.value), type: 'money' },
          { header: 'Right', value: (r) => r.right.label, width: 28 },
          { header: 'Right value', value: (r) => Number(r.right.value), type: 'money' },
          { header: 'Difference USD', value: (r) => Number(r.differenceUsd), type: 'money' },
        ],
      });
    },
  },

  forex: {
    title: 'Forex Gain / Loss',
    permission: PERMISSIONS.ACCOUNTING_VIEW,
    build: async (user, query) => {
      const from = dateParam(query, 'from') ?? startOfYear();
      const to = dateParam(query, 'to') ?? new Date();
      const local = user.activeCompany.localCurrency;
      const report = await getForexGainLoss({ companyId: user.activeCompany.id, from, to });

      return buildWorkbook({
        companyName: user.activeCompany.name,
        title: 'Forex Gain / Loss',
        subtitle: `${period(from, to)} · net USD ${Number(report.netUsd).toFixed(2)} (positive is a loss)`,
        rows: report.rows,
        totals: ['Loss USD', 'Gain USD', `Loss ${local}`, `Gain ${local}`],
        columns: [
          { header: 'Date', value: (r) => r.entryDate, type: 'date' },
          { header: 'Voucher', value: (r) => r.entryNumber },
          { header: 'Source', value: (r) => r.sourceType.replaceAll('_', ' ') },
          { header: 'Description', value: (r) => r.description, width: 40 },
          { header: 'Currency', value: (r) => r.currency },
          { header: 'Loss USD', value: (r) => Number(r.debitUsd), type: 'money' },
          { header: 'Gain USD', value: (r) => Number(r.creditUsd), type: 'money' },
          { header: `Loss ${local}`, value: (r) => Number(r.debitLocal), type: 'money' },
          { header: `Gain ${local}`, value: (r) => Number(r.creditLocal), type: 'money' },
        ],
      });
    },
  },

  'inventory-valuation': {
    title: 'Inventory Valuation',
    permission: PERMISSIONS.INVENTORY_VIEW,
    build: async (user) => {
      const rows = await getInventoryValuation(user.activeCompany.id);
      const showCost = can(user, PERMISSIONS.PURCHASE_COST_VIEW);
      return buildWorkbook({
        companyName: user.activeCompany.name,
        title: 'Inventory Valuation',
        subtitle: showCost
          ? 'On-hand stock at each batch landed cost'
          : 'On-hand quantities. Cost figures are not part of your access.',
        rows,
        totals: showCost ? ['On hand (KG)', 'Available (KG)', 'Value (USD)'] : ['On hand (KG)', 'Available (KG)'],
        columns: [
          { header: 'Warehouse', value: (r) => r.warehouseName, width: 26 },
          { header: 'Code', value: (r) => r.warehouseCode },
          { header: 'Coffee', value: (r) => r.itemName, width: 28 },
          { header: 'Batch', value: (r) => r.batchNumber },
          { header: 'Lot', value: (r) => r.lotNumber },
          { header: 'Container', value: (r) => r.containerNumber ?? '' },
          { header: 'On hand (KG)', value: (r) => Number(r.onHandKg), type: 'quantity' },
          { header: 'Available (KG)', value: (r) => Number(r.availableKg), type: 'quantity' },
          ...(showCost
            ? [
                { header: 'Landed / KG (USD)', value: (r: (typeof rows)[number]) => Number(r.landedUnitCostUsd), type: 'money' as const },
                { header: 'Value (USD)', value: (r: (typeof rows)[number]) => Number(r.valueUsd), type: 'money' as const },
              ]
            : []),
        ],
      });
    },
  },

  cogs: {
    title: 'Cost of Goods Sold',
    permission: PERMISSIONS.PROFITS_VIEW,
    build: async (user, query) => {
      const from = dateParam(query, 'from') ?? startOfYear();
      const to = dateParam(query, 'to') ?? new Date();
      const rows = await getCogsReport({ companyId: user.activeCompany.id, from, to });
      return buildWorkbook({
        companyName: user.activeCompany.name,
        title: 'Cost of Goods Sold',
        subtitle: period(from, to),
        rows,
        totals: ['Quantity (KG)', 'Revenue (USD)', 'COGS (USD)', 'Gross profit (USD)'],
        columns: [
          { header: 'Date', value: (r) => r.invoiceDate, type: 'date' },
          { header: 'Invoice', value: (r) => r.invoiceNumber },
          { header: 'Customer', value: (r) => r.customerName, width: 28 },
          { header: 'Coffee', value: (r) => r.itemName, width: 28 },
          { header: 'Batch', value: (r) => r.batchNumber },
          { header: 'Warehouse', value: (r) => r.warehouseName ?? '' },
          { header: 'Quantity (KG)', value: (r) => Number(r.quantityKg), type: 'quantity' },
          { header: 'Revenue (USD)', value: (r) => Number(r.revenueUsd), type: 'money' },
          { header: 'COGS (USD)', value: (r) => Number(r.cogsUsd), type: 'money' },
          { header: 'Gross profit (USD)', value: (r) => Number(r.grossProfitUsd), type: 'money' },
        ],
      });
    },
  },

  'agent-commission': {
    title: 'Agent Commission',
    permission: PERMISSIONS.EXPENSES_VIEW,
    build: async (user) => {
      const rows = await getAgentCommissionRegister(user.activeCompany.id);
      return buildWorkbook({
        companyName: user.activeCompany.name,
        title: 'Agent Commission',
        subtitle: 'Commission agreed on a shipment, whether or not it has been paid',
        rows,
        totals: ['Amount USD', 'Paid USD', 'Outstanding USD'],
        columns: [
          { header: 'Voucher', value: (r) => r.expenseNumber },
          { header: 'Date', value: (r) => r.expenseDate, type: 'date' },
          { header: 'Agent', value: (r) => r.agentName, width: 26 },
          { header: 'Contract ref', value: (r) => r.contractReference ?? '', width: 22 },
          { header: 'Shipment', value: (r) => r.jobNumber ?? '' },
          { header: 'Container', value: (r) => r.containerNumber ?? '' },
          { header: 'Currency', value: (r) => r.currency },
          { header: 'Amount', value: (r) => Number(r.amount), type: 'money' },
          { header: 'Rate to USD', value: (r) => Number(r.rateToUsd), type: 'number' },
          { header: 'Amount USD', value: (r) => Number(r.amountUsd), type: 'money' },
          { header: 'Paid USD', value: (r) => Number(r.paidUsd), type: 'money' },
          { header: 'Outstanding USD', value: (r) => Number(r.remainingUsd), type: 'money' },
          { header: 'Status', value: (r) => r.status },
        ],
      });
    },
  },

  'customer-ledger': {
    title: 'Customer Ledger',
    permission: PERMISSIONS.LEDGERS_VIEW,
    build: async (user, query) => {
      const data = await customerLedgerExport(user, query);
      const range =
        data.from || data.to
          ? `${data.from ? asDay(data.from) : 'start'} to ${data.to ? asDay(data.to) : 'today'}`
          : 'all dates';
      return buildWorkbook({
        companyName: user.activeCompany.name,
        title: `Statement — ${data.customer.customerName}`,
        subtitle: `${data.customer.customerCode} · ${data.view} · ${range}`,
        rows: data.ledger.rows,
        columns: [
          { header: 'Date', value: (r) => r.entryDate, type: 'date' },
          { header: 'Voucher', value: (r) => r.entryNumber },
          { header: 'Type', value: (r) => r.sourceType.replaceAll('_', ' ') },
          { header: 'Reference', value: (r) => r.reference ?? '' },
          { header: 'Description', value: (r) => r.description, width: 40 },
          { header: 'Debit', value: (r) => Number(r.debit), type: 'money' },
          { header: 'Credit', value: (r) => Number(r.credit), type: 'money' },
          { header: 'Balance', value: (r) => Number(r.balance), type: 'money' },
          { header: 'Currency', value: (r) => r.currency },
        ],
      });
    },
    csv: async (user, query) => {
      const data = await customerLedgerExport(user, query);
      return { headers: data.headers, rows: data.rows };
    },
  },

  'vendor-ledger': {
    title: 'Supplier Ledger',
    permission: PERMISSIONS.LEDGERS_VIEW,
    build: async (user, query) => {
      const data = await vendorLedgerExport(user, query);
      const range =
        data.from || data.to
          ? `${data.from ? asDay(data.from) : 'start'} to ${data.to ? asDay(data.to) : 'today'}`
          : 'all dates';
      return buildWorkbook({
        companyName: user.activeCompany.name,
        title: `Statement — ${data.vendor.vendorName}`,
        subtitle: `${data.vendor.vendorCode} · ${data.view} · ${range}`,
        rows: data.ledger.rows,
        columns: [
          { header: 'Date', value: (r) => r.entryDate, type: 'date' },
          { header: 'Voucher', value: (r) => r.entryNumber },
          { header: 'Type', value: (r) => r.sourceType.replaceAll('_', ' ') },
          { header: 'Reference', value: (r) => r.reference ?? '' },
          { header: 'Description', value: (r) => r.description, width: 40 },
          { header: 'Debit', value: (r) => Number(r.debit), type: 'money' },
          { header: 'Credit', value: (r) => Number(r.credit), type: 'money' },
          { header: 'Balance', value: (r) => Number(r.balance), type: 'money' },
          { header: 'Currency', value: (r) => r.currency },
        ],
      });
    },
    csv: async (user, query) => {
      const data = await vendorLedgerExport(user, query);
      return { headers: data.headers, rows: data.rows };
    },
  },
};

/** The heading an expense grouping deserves once it is a column. */
function titleFor(groupBy: ExpenseGrouping): string {
  const HEADINGS: Record<ExpenseGrouping, string> = {
    type: 'Type',
    category: 'Category',
    shipment: 'Job',
    payee: 'Payee',
    month: 'Month',
  };
  return HEADINGS[groupBy];
}

export async function GET(request: Request, context: { params: Promise<{ report: string }> }) {
  try {
    const { report } = await context.params;
    const definition = REPORTS[report];
    if (!definition) throw new NotFoundError('Report');

    const query = new URL(request.url).searchParams;
    const user = await requirePermission(definition.permission as never);

    if (query.get('format') === 'csv') {
      if (!definition.csv) throw new NotFoundError('Report');
      const { headers, rows } = await definition.csv(user, query);
      const body = buildCsv(headers, rows);
      return new NextResponse(new Uint8Array(body), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Length': String(body.byteLength),
          'Content-Disposition': `attachment; filename="${workbookFileName(definition.title, user.activeCompany.code, 'csv')}"`,
          'Cache-Control': 'private, no-store',
        },
      });
    }

    const workbook = await definition.build(user, query);

    return new NextResponse(new Uint8Array(workbook), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Length': String(workbook.byteLength),
        'Content-Disposition': `attachment; filename="${workbookFileName(definition.title, user.activeCompany.code)}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    const response = toErrorResponse(error);
    return NextResponse.json({ error: response.message }, { status: response.status ?? 400 });
  }
}
