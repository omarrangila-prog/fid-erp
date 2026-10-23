import { shortDocumentNumber } from '@/lib/short-number';
import { getOrderCostSheets } from '@/lib/services/order-cost';
import { NextResponse } from 'next/server';
import { requirePermission, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { toErrorResponse, NotFoundError, ForbiddenError } from '@/lib/errors';
import { prisma } from '@/lib/db';
import { getCostOfSalesBreakdown } from '@/lib/services/cost-of-sales-breakdown';
import { BALANCE_SHEET_GROUPS } from '@/lib/balance-sheet-groups';
import { clientLabel, isUnusedInPeriod } from '@/lib/trial-balance-view';
import { dec, sum } from '@/lib/money';
import {
  buildWorkbook,
  buildStatementWorkbook,
  buildCsv,
  csvFromWorkbook,
  workbookFileName,
  type StatementRow,
} from '@/lib/services/workbook';
import { getLoadingSheet } from '@/lib/services/loading-sheet';
import {
  getReceivables,
  getPayables,
  getReceivablesAgeing,
  getPayablesAgeing,
  AGEING_BUCKETS,
  AGEING_LABELS,
} from '@/lib/services/receivables';
import { getBatchStock, getStockAgeing, getInventoryValuation, getStockMovementSummary } from '@/lib/services/stock';
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
  getSalesRegister,
  getPurchaseRegister,
  getSalesBy,
  getCustomerBalances,
  getVendorBalances,
  type SalesDimension,
  type ExpenseGrouping,
  type PnlLine,
} from '@/lib/services/reports';
import { getAgentCommissionRegister } from '@/lib/services/agent-commission';
import { getShipmentCostSheet } from '@/lib/services/landed-cost';
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
import { shipmentStage, shipmentResult, getClosedDates, SHIPMENT_STAGE_LABELS } from '@/lib/services/shipment-performance';
import type { SessionUser } from '@/lib/auth/session';
import { calendarDay } from '@/lib/validation/common';

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
  return calendarDay(raw) ?? undefined;
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
function pnlSection(title: string, lines: PnlLine[], total: { usd: unknown; local: unknown }, totalLabel = `Total ${title.toLowerCase()}`): StatementRow[] {
  return [
    { kind: 'section', label: title },
    ...lines.map((line): StatementRow => ({
      kind: 'line',
      label: line.name,
      code: line.code,
      // The company's own currency first, as on screen; the USD equivalent beside it.
      values: [Number(line.amountLocal), Number(line.amountUsd)],
    })),
    { kind: 'total', label: totalLabel, values: [Number(total.local), Number(total.usd)] },
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
        timeZone: user.activeCompany.timezone,
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
        timeZone: user.activeCompany.timezone,
        title: 'Stock Allocation',
        subtitle: 'Each purchase and every customer it was sold to',
        rows,
        totals: ['Sold (KG)', 'Value', 'Outstanding'],
        columns: [
          { header: 'Contract ref', value: (r) => r.contractReference },
          { header: 'Batch', value: (r) => r.batchNumber },
          { header: 'Coffee', value: (r) => r.itemName, width: 34 },
          { header: 'Purchased (KG)', value: (r) => r.purchased, type: 'quantity' },
          { header: 'Customer', value: (r) => r.customerName, width: 30 },
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
        timeZone: user.activeCompany.timezone,
        title: 'Customer Receivables',
        subtitle: 'Outstanding invoices, oldest first',
        rows,
        totals: ['Invoice total', 'Received', 'Outstanding', 'Outstanding (USD)'],
        columns: [
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
        timeZone: user.activeCompany.timezone,
        title: 'Supplier Payables',
        subtitle: 'Outstanding contracts, oldest first',
        rows,
        totals: ['Contract value', 'Paid', 'Outstanding', 'Outstanding (USD)'],
        columns: [
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
        timeZone: user.activeCompany.timezone,
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
        timeZone: user.activeCompany.timezone,
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
          timeZone: user.activeCompany.timezone,
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
          timeZone: user.activeCompany.timezone,
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

      // Each container's stage: profit on what sold, stock at cost beside it,
      // and a final result only once it is closed — as the screen shows it.
      const closedDates = await getClosedDates(companyId, rows.map((r) => r.shipmentId));
      const stageOf = new Map(
        rows.map((r) => {
          const stage = shipmentStage({ remainingKg: r.onHandQuantityKg, soldKg: r.soldQuantityKg, closed: r.status === 'CLOSED' });
          const result = shipmentResult({
            stage,
            revenueLocal: r.salesRevenueLocal,
            grossProfitLocal: r.grossProfitLocal,
            soldKg: r.soldQuantityKg,
            periodCostsLocal: r.otherCostsLocal,
            overheadLocal: r.allocatedOverheadLocal,
          });
          return [r.shipmentId, { stage, result }] as const;
        }),
      );
      const st = (r: (typeof rows)[number]) => stageOf.get(r.shipmentId)!;

      // The statement layout: every measure the screen lays out, one shipment per row.
      if (view === 'statement') {
        return buildWorkbook({
          companyName: user.activeCompany.name,
          timeZone: user.activeCompany.timezone,
          title: 'Shipment Profitability Statement',
          subtitle: `Net profit USD ${Number(summary.netProfitUsd).toFixed(2)}`,
          rows: rows.slice().reverse(),
          totals: [
            'Purchased (KG)', 'Received (KG)', 'Sold (KG)', 'Remaining (KG)',
            'Purchase cost (USD)', 'Direct expenses (USD)', 'Landed cost (USD)',
            `Purchase cost (${local})`, `Direct expenses (${local})`, `Landed cost (${local})`,
            'Closing stock (KG)', 'Closing stock value (USD)',
            'Revenue (USD)', 'Cost of goods sold (USD)', 'Gross profit (USD)', 'Other costs (USD)', 'Net profit (USD)',
            `Revenue (${local})`, `Cost of goods sold (${local})`, `Gross profit (${local})`, `Net profit (${local})`,
          ],
          columns: [
            { header: 'Contract ref', value: (r) => r.contractReference, width: 22 },
            { header: 'Coffee', value: (r) => r.itemName, width: 28 },
            { header: 'Status', value: (r) => r.status },
            { header: 'Purchased (KG)', value: (r) => Number(r.purchaseQuantityKg), type: 'quantity' as const },
            { header: 'Received (KG)', value: (r) => Number(r.receivedQuantityKg), type: 'quantity' as const },
            { header: 'Sold (KG)', value: (r) => Number(r.soldQuantityKg), type: 'quantity' as const },
            { header: 'Remaining (KG)', value: (r) => Number(r.remainingQuantityKg), type: 'quantity' as const },
            { header: 'Purchase cost (USD)', value: (r) => Number(r.goodsCostUsd), type: 'money' as const },
            { header: 'Direct expenses (USD)', value: (r) => Number(r.capitalisedCostUsd), type: 'money' as const },
            { header: 'Landed cost (USD)', value: (r) => Number(r.totalLandedCostUsd), type: 'money' as const },
            { header: 'Landed cost per KG (USD)', value: (r) => Number(r.landedCostPerKgUsd), type: 'money' as const },
            { header: `Purchase cost (${local})`, value: (r) => Number(r.goodsCostLocal), type: 'money' as const },
            { header: `Direct expenses (${local})`, value: (r) => Number(r.capitalisedCostLocal), type: 'money' as const },
            { header: `Landed cost (${local})`, value: (r) => Number(r.totalLandedCostLocal), type: 'money' as const },
            { header: `Landed cost per KG (${local})`, value: (r) => Number(r.landedCostPerKgLocal), type: 'money' as const },
            { header: 'Closing stock (KG)', value: (r) => Number(r.onHandQuantityKg), type: 'quantity' as const },
            { header: 'Closing stock value (USD)', value: (r) => Number(r.closingStockValueUsd), type: 'money' as const },
            { header: 'Revenue (USD)', value: (r) => Number(r.salesRevenueUsd), type: 'money' as const },
            { header: 'Average selling price (USD/KG)', value: (r) => Number(r.averageSellingPriceUsd), type: 'money' as const },
            { header: 'Cost of goods sold (USD)', value: (r) => Number(r.allocatedLandedCostUsd), type: 'money' as const },
            { header: 'Gross profit (USD)', value: (r) => Number(r.grossProfitUsd), type: 'money' as const },
            { header: 'Other costs (USD)', value: (r) => Number(r.otherCostsUsd), type: 'money' as const },
            { header: 'Net profit (USD)', value: (r) => Number(r.netProfitUsd), type: 'money' as const },
            { header: `Revenue (${local})`, value: (r) => Number(r.salesRevenueLocal), type: 'money' as const },
            { header: `Cost of goods sold (${local})`, value: (r) => Number(r.allocatedLandedCostLocal), type: 'money' as const },
            { header: `Gross profit (${local})`, value: (r) => Number(r.grossProfitLocal), type: 'money' as const },
            { header: `Net profit (${local})`, value: (r) => Number(r.netProfitLocal), type: 'money' as const },
            { header: 'Gross margin', value: (r) => Number(r.grossMarginPct) / 100, type: 'percent' as const },
            { header: 'Net margin', value: (r) => Number(r.netMarginPct) / 100, type: 'percent' as const },
            { header: 'Profit per KG (USD)', value: (r) => Number(r.profitPerKgUsd), type: 'money' as const },
            { header: 'Shipment stage', value: (r) => SHIPMENT_STAGE_LABELS[st(r).stage], width: 30 },
            { header: `Remaining inventory value (${local}) — at cost, not profit`, value: (r) => Number(r.closingStockValueLocal), type: 'money' as const },
            { header: `Final net profit (${local})`, value: (r) => (st(r).stage === 'CLOSED' ? Number(st(r).result.netLocal) : 'Not final') },
            { header: 'Closed date', value: (r) => (closedDates.get(r.shipmentId) ? asDay(closedDates.get(r.shipmentId)!) : '') },
          ],
        });
      }

      return buildWorkbook({
        companyName: user.activeCompany.name,
        timeZone: user.activeCompany.timezone,
        title: 'Profitability',
        subtitle: `${byContract ? 'By contract' : 'By job'} · net profit USD ${Number(summary.netProfitUsd).toFixed(2)}`,
        rows,
        totals: ['Sold (KG)', 'Revenue (USD)', `Revenue (${local})`, 'Landed cost (USD)', 'Gross profit (USD)', 'Other costs (USD)', 'Net profit (USD)', `Net profit (${local})`],
        columns: [
          ...(byContract
            ? [
                { header: 'Contract ref', value: (r: (typeof rows)[number]) => r.contractReference, width: 22 },
              ]
            : [
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
          { header: 'Shipment stage', value: (r) => SHIPMENT_STAGE_LABELS[st(r).stage], width: 30 },
          { header: 'Received (KG)', value: (r) => Number(r.receivedQuantityKg), type: 'quantity' as const },
          { header: 'Remaining available (KG)', value: (r) => Number(r.onHandQuantityKg), type: 'quantity' as const },
          { header: `COGS (${local})`, value: (r) => Number(r.allocatedLandedCostLocal), type: 'money' as const },
          { header: `Gross profit on sold goods (${local})`, value: (r) => Number(r.grossProfitLocal), type: 'money' as const },
          { header: 'Gross margin', value: (r) => Number(r.grossMarginPct) / 100, type: 'percent' as const },
          { header: `Remaining inventory value (${local})`, value: (r) => Number(r.closingStockValueLocal), type: 'money' as const },
          {
            header: `Profit to date (${local})`,
            value: (r) => (st(r).stage !== 'CLOSED' && st(r).result.hasDeductions ? Number(st(r).result.netLocal) : ''),
          },
          { header: `Final net profit (${local})`, value: (r) => (st(r).stage === 'CLOSED' ? Number(st(r).result.netLocal) : 'Not final') },
          { header: 'Closed date', value: (r) => (closedDates.get(r.shipmentId) ? asDay(closedDates.get(r.shipmentId)!) : '') },
        ],
      });
    },
  },

  /*
   * The ageing matrix, one row per party and currency with a column per
   * bucket — the same rows the screen shows, so a file and the screen state
   * the same debt.
   */
  ageing: {
    title: 'Ageing',
    permission: PERMISSIONS.ACCOUNTING_VIEW,
    build: async (user, query) => {
      const payables = query.get('side') === 'payables';
      const rows = payables ? await getPayablesAgeing(user.activeCompany.id) : await getReceivablesAgeing(user.activeCompany.id);
      return buildWorkbook({
        companyName: user.activeCompany.name,
        timeZone: user.activeCompany.timezone,
        title: payables ? 'Accounts Payable Ageing' : 'Accounts Receivable Ageing',
        subtitle: `As at ${asDay(new Date())}`,
        rows,
        totals: [...AGEING_BUCKETS.map((b) => AGEING_LABELS[b]), 'Total', 'Total (USD)'],
        columns: [
          { header: payables ? 'Supplier' : 'Customer', value: (r) => r.partyName, width: 32 },
          { header: 'Currency', value: (r) => r.currency },
          ...AGEING_BUCKETS.map((bucket) => ({
            header: AGEING_LABELS[bucket],
            value: (r: (typeof rows)[number]) => Number(r.byBucket[bucket]),
            type: 'money' as const,
          })),
          { header: 'Total', value: (r) => Number(r.total), type: 'money' as const },
          { header: 'Total (USD)', value: (r) => Number(r.totalUsd), type: 'money' as const },
          { header: 'Documents', value: (r) => r.lines.length, type: 'integer' as const },
        ],
      });
    },
  },

  /** The documents behind the ageing, one row each. */
  'ageing-detail': {
    title: 'Ageing Detail',
    permission: PERMISSIONS.ACCOUNTING_VIEW,
    build: async (user, query) => {
      const payables = query.get('side') === 'payables';
      const parties = payables ? await getPayablesAgeing(user.activeCompany.id) : await getReceivablesAgeing(user.activeCompany.id);
      const rows = parties.flatMap((party) => party.lines.map((line) => ({ party, line })));
      return buildWorkbook({
        companyName: user.activeCompany.name,
        timeZone: user.activeCompany.timezone,
        title: payables ? 'Accounts Payable Ageing — Detail' : 'Accounts Receivable Ageing — Detail',
        subtitle: `As at ${asDay(new Date())}`,
        rows,
        totals: ['Outstanding', 'Outstanding (USD)'],
        columns: [
          { header: payables ? 'Supplier' : 'Customer', value: (r) => r.party.partyName, width: 32 },
          { header: payables ? 'Order' : 'Invoice', value: (r) => r.line.documentLabel, width: 22 },
          { header: 'Date', value: (r) => r.line.documentDate, type: 'date' as const },
          { header: 'Due', value: (r) => r.line.dueDate, type: 'date' as const },
          { header: 'Days overdue', value: (r) => r.line.daysOverdue, type: 'integer' as const },
          { header: 'Bucket', value: (r) => AGEING_LABELS[r.line.bucket] },
          { header: 'Currency', value: (r) => r.line.currency },
          { header: 'Original', value: (r) => Number(r.line.originalAmount), type: 'money' as const },
          { header: 'Paid', value: (r) => Number(r.line.paidAmount), type: 'money' as const },
          { header: 'Outstanding', value: (r) => Number(r.line.outstandingAmount), type: 'money' as const },
          { header: 'Outstanding (USD)', value: (r) => Number(r.line.outstandingUsd), type: 'money' as const },
        ],
      });
    },
  },

  /** What each customer or supplier owes, one line per party and currency. */
  balances: {
    title: 'Balances',
    permission: PERMISSIONS.ACCOUNTING_VIEW,
    build: async (user, query) => {
      const suppliers = query.get('side') === 'suppliers';
      const rows = suppliers ? await getVendorBalances(user.activeCompany.id) : await getCustomerBalances(user.activeCompany.id);
      return buildWorkbook({
        companyName: user.activeCompany.name,
        timeZone: user.activeCompany.timezone,
        title: suppliers ? 'Supplier Balances' : 'Customer Balances',
        subtitle: `As at ${asDay(new Date())}`,
        rows,
        totals: ['Balance (USD)'],
        columns: [
          { header: suppliers ? 'Supplier' : 'Customer', value: (r) => r.partyName, width: 32 },
          { header: 'Currency', value: (r) => r.currency },
          { header: 'Balance', value: (r) => Number(r.balance), type: 'money' as const },
          { header: 'Balance (USD)', value: (r) => Number(r.balanceUsd), type: 'money' as const },
        ],
      });
    },
  },

  /** Sales summarised by whichever dimension the screen was showing. */
  'sales-by': {
    title: 'Sales By',
    permission: PERMISSIONS.REPORTS_VIEW,
    build: async (user, query) => {
      const by = (['customer', 'item', 'shipment', 'warehouse', 'batch'].includes(query.get('by') ?? '')
        ? query.get('by')
        : 'customer') as SalesDimension;
      const from = dateParam(query, 'from') ?? startOfYear();
      const to = dateParam(query, 'to') ?? new Date();
      const rows = await getSalesBy({ companyId: user.activeCompany.id, from, to, by });
      const local = user.activeCompany.localCurrency;
      const canProfit = can(user, PERMISSIONS.PROFITS_VIEW);
      const titles: Record<SalesDimension, string> = {
        customer: 'Sales by Customer',
        item: 'Sales by Coffee',
        shipment: 'Sales by Shipment',
        warehouse: 'Sales by Warehouse',
        batch: 'Sales by Batch',
      };
      return buildWorkbook({
        companyName: user.activeCompany.name,
        timeZone: user.activeCompany.timezone,
        title: titles[by],
        subtitle: period(from, to),
        rows,
        totals: ['Quantity (KG)', `Revenue (${local})`, `Cost (${local})`, `Gross profit (${local})`, 'Revenue (USD)', 'Cost (USD)', 'Gross profit (USD)'],
        columns: [
          { header: titles[by].replace('Sales by ', ''), value: (r) => r.label, width: 32 },
          { header: 'Invoices', value: (r) => r.invoices, type: 'integer' as const },
          { header: 'Quantity (KG)', value: (r) => Number(r.quantityKg), type: 'quantity' as const },
          { header: `Revenue (${local})`, value: (r) => Number(r.revenueLocal), type: 'money' as const },
          // As on screen: cost and profit only for those who may see profit.
          ...(canProfit
            ? [
                { header: `Cost (${local})`, value: (r: (typeof rows)[number]) => Number(r.costLocal), type: 'money' as const },
                { header: `Gross profit (${local})`, value: (r: (typeof rows)[number]) => Number(r.grossProfitLocal), type: 'money' as const },
                { header: 'Margin', value: (r: (typeof rows)[number]) => Number(r.marginPct) / 100, type: 'percent' as const },
              ]
            : []),
          { header: 'Revenue (USD)', value: (r) => Number(r.revenueUsd), type: 'money' as const },
          ...(canProfit
            ? [
                { header: 'Cost (USD)', value: (r: (typeof rows)[number]) => Number(r.costUsd), type: 'money' as const },
                { header: 'Gross profit (USD)', value: (r: (typeof rows)[number]) => Number(r.grossProfitUsd), type: 'money' as const },
              ]
            : []),
        ],
      });
    },
  },

  /** Opening stock, what moved, closing stock — for a day or any range. */
  'stock-movement': {
    title: 'Daily Stock Movement',
    permission: PERMISSIONS.INVENTORY_VIEW,
    build: async (user, query) => {
      const from = dateParam(query, 'from') ?? startOfYear();
      const to = dateParam(query, 'to') ?? new Date();
      const warehouseId = query.get('warehouse') || undefined;
      const rows = await getStockMovementSummary({ companyId: user.activeCompany.id, from, to, warehouseId });
      return buildWorkbook({
        companyName: user.activeCompany.name,
        timeZone: user.activeCompany.timezone,
        title: 'Daily Stock Movement',
        subtitle: period(from, to),
        rows,
        totals: ['Opening (KG)', 'Received (KG)', 'Transferred in (KG)', 'Transferred out (KG)', 'Sold (KG)', 'Adjustments (KG)', 'Closing (KG)', 'Closing value (USD)'],
        columns: [
          { header: 'Coffee', value: (r) => r.itemName, width: 32 },
          { header: 'Warehouse', value: (r) => r.warehouseName, width: 24 },
          { header: 'Opening (KG)', value: (r) => Number(r.openingKg), type: 'quantity' as const },
          { header: 'Received (KG)', value: (r) => Number(r.receiptsKg), type: 'quantity' as const },
          { header: 'Transferred in (KG)', value: (r) => Number(r.transfersInKg), type: 'quantity' as const },
          { header: 'Transferred out (KG)', value: (r) => Number(r.transfersOutKg), type: 'quantity' as const },
          { header: 'Sold (KG)', value: (r) => Number(r.salesKg), type: 'quantity' as const },
          { header: 'Adjustments (KG)', value: (r) => Number(r.adjustmentsKg), type: 'quantity' as const },
          { header: 'Closing (KG)', value: (r) => Number(r.closingKg), type: 'quantity' as const },
          { header: 'Closing value (USD)', value: (r) => Number(r.closingValueUsd), type: 'money' as const },
        ],
      });
    },
  },

  /** One shipment's cost sheet: the coffee, then every charge booked to it. */
  'shipment-cost': {
    title: 'Shipment Cost',
    permission: PERMISSIONS.PURCHASE_COST_VIEW,
    build: async (user, query) => {
      // By order (every container of the shipment), or by one shipment record.
      const orderId = query.get('order');
      // No order named: the overview, one line per shipment with each measure
      // the requirements ask the Shipment Profitability Report to show.
      if (!orderId && !query.get('shipment')) {
        const sheets = await getOrderCostSheets(user.activeCompany.id);
        const local = user.activeCompany.localCurrency;
        const profit = can(user, PERMISSIONS.PROFITS_VIEW);
        type S = (typeof sheets)[number];
        return buildWorkbook({
          companyName: user.activeCompany.name,
          timeZone: user.activeCompany.timezone,
          title: 'Shipment-wise Profitability',
          subtitle: `${sheets.length} shipments · ${local}`,
          rows: sheets,
          totals: ['Purchased KG', `Purchase value ${local}`, `Direct shipment costs ${local}`, `Landed cost ${local}`, 'Quantity sold KG', `Sales value ${local}`, 'Remaining KG', `Closing stock value ${local}`, ...(profit ? [`Cost of the coffee sold ${local}`, `Gross profit ${local}`, `Other expenses allocated to the shipment ${local}`, `Net profit ${local}`] : []), `Unpaid customer balance ${local}`, `Unpaid supplier balance ${local}`, `Unpaid shipment expenses ${local}`],
          columns: [
            { header: 'Shipment (ICUL/FID)', value: (r) => r.contractReference, width: 30 },
            { header: 'Supplier', value: (r) => r.vendorName, width: 26 },
            { header: 'Purchased KG', value: (r) => Number(r.orderedKg), type: 'quantity' as const },
            { header: `Purchase value ${local}`, value: (r) => Number(r.goodsLocal), type: 'money' as const },
            { header: `Direct shipment costs ${local}`, value: (r) => Number(r.capitalisedExpenseLocal), type: 'money' as const },
            { header: `Landed cost ${local}`, value: (r) => Number(r.landedLocal), type: 'money' as const },
            { header: `Landed cost / KG ${local}`, value: (r) => Number(r.costPerKgLocal), type: 'money' as const },
            { header: 'Quantity sold KG', value: (r) => Number(r.invoicedKg), type: 'quantity' as const },
            { header: `Sales value ${local}`, value: (r) => Number(r.revenueLocal), type: 'money' as const },
            { header: `Avg selling price / KG ${local}`, value: (r) => Number(r.averageSellingPriceLocal), type: 'money' as const },
            { header: 'Remaining KG', value: (r) => Number(r.remainingKg), type: 'quantity' as const },
            { header: `Closing stock value ${local}`, value: (r) => Number(r.remainingValueLocal), type: 'money' as const },
            ...(profit
              ? [
                  { header: `Cost of the coffee sold ${local}`, value: (r: S) => Number(r.cogsLocal), type: 'money' as const },
                  { header: `Gross profit ${local}`, value: (r: S) => Number(r.grossProfitLocal), type: 'money' as const },
                  { header: 'Gross margin', value: (r: S) => Number(r.marginPct) / 100, type: 'percent' as const },
                  { header: `Other expenses allocated to the shipment ${local}`, value: (r: S) => Number(r.periodExpenseLocal), type: 'money' as const },
                  { header: `Net profit ${local}`, value: (r: S) => Number(r.netProfitLocal), type: 'money' as const },
                ]
              : []),
            { header: `Unpaid customer balance ${local}`, value: (r) => Number(r.customerOutstandingLocal), type: 'money' as const },
            { header: `Unpaid supplier balance ${local}`, value: (r) => Number(r.supplierOutstandingLocal), type: 'money' as const },
            { header: `Unpaid shipment expenses ${local}`, value: (r) => Number(r.expenseOutstandingLocal), type: 'money' as const },
          ],
        });
      }
      if (orderId) {
        const sheet = (await getOrderCostSheets(user.activeCompany.id)).find((s) => s.contractId === orderId);
        if (!sheet) throw new NotFoundError('Shipment');
        return buildWorkbook({
          companyName: user.activeCompany.name,
          timeZone: user.activeCompany.timezone,
          title: 'Shipment-wise Profitability — shipment detail',
          subtitle: `${sheet.contractReference} · ${sheet.items.length} items · ${sheet.containers} containers · landed ${sheet.localCurrency} ${Number(sheet.landedLocal).toLocaleString('en-US', { minimumFractionDigits: 2 })}${can(user, PERMISSIONS.PROFITS_VIEW) ? ` · profit ${sheet.localCurrency} ${Number(sheet.grossProfitLocal).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : ''}`,
          // Every direct expense, by category, with what is settled and still owed — as on screen.
          rows: [...sheet.expenses].sort((a, b) => a.category.localeCompare(b.category) || a.expenseDate.getTime() - b.expenseDate.getTime()),
          totals: [`Original cost (${sheet.localCurrency})`, `Settled (${sheet.localCurrency})`, `Outstanding (${sheet.localCurrency})`, 'Amount (USD)'],
          columns: [
            { header: 'Date', value: (r) => r.expenseDate, type: 'date' as const },
            { header: 'Category', value: (r) => r.category, width: 28 },
            { header: 'Memo', value: (r) => r.memo ?? '', width: 32 },
            { header: 'Container', value: (r) => r.containerNumber ?? 'Whole shipment' },
            { header: 'Currency', value: (r) => r.currency },
            { header: 'Amount', value: (r) => Number(r.amount), type: 'money' as const },
            { header: `Original cost (${sheet.localCurrency})`, value: (r) => Number(r.originalLocal), type: 'money' as const },
            { header: `Settled (${sheet.localCurrency})`, value: (r) => Number(r.settledLocal), type: 'money' as const },
            { header: `Outstanding (${sheet.localCurrency})`, value: (r) => Number(r.outstandingLocal), type: 'money' as const },
            { header: 'Status', value: (r) => (r.payment === 'PAID' ? 'Settled' : r.payment === 'PARTIAL' ? 'Partly settled' : 'Outstanding') },
            { header: 'Settled from', value: (r) => r.paidFrom ?? '' },
            { header: 'Amount (USD)', value: (r) => Number(r.amountUsd), type: 'money' as const },
            { header: 'In the coffee’s cost?', value: (r) => (r.capitalised ? 'Yes' : 'No') },
          ],
        });
      }
      const shipmentId = query.get('shipment');
      if (!shipmentId) throw new NotFoundError('Shipment');
      const sheet = await getShipmentCostSheet(user.activeCompany.id, shipmentId);
      if (!sheet) throw new NotFoundError('Shipment');
      return buildWorkbook({
        companyName: user.activeCompany.name,
        timeZone: user.activeCompany.timezone,
        title: 'Shipment Cost Report',
        subtitle: sheet.contractReference,
        rows: sheet.lines,
        totals: ['Amount (USD)', `Amount (${sheet.localCurrency})`],
        columns: [
          { header: 'Date', value: (r) => r.expenseDate, type: 'date' as const },
          { header: 'Category', value: (r) => r.category, width: 28 },
          { header: 'Memo', value: (r) => r.description ?? '', width: 32 },
          { header: 'Container', value: (r) => r.containerNumber ?? '' },
          { header: 'Currency', value: (r) => r.currency },
          { header: 'Amount', value: (r) => Number(r.amount), type: 'money' as const },
          { header: 'Amount (USD)', value: (r) => Number(r.amountUsd), type: 'money' as const },
          { header: `Amount (${sheet.localCurrency})`, value: (r) => Number(r.amountLocal), type: 'money' as const },
          { header: 'In the coffee?', value: (r) => (r.capitalised ? 'Yes' : 'No — a running cost') },
          { header: 'Paid', value: (r) => (r.paid ? (r.paidFrom ?? 'Paid') : 'Owed') },
        ],
      });
    },
  },

  'sales-register': {
    title: 'Sales Report',
    permission: PERMISSIONS.REPORTS_VIEW,
    build: async (user, query) => {
      const from = dateParam(query, 'from');
      const to = dateParam(query, 'to');
      const reference = query.get('ref') ?? undefined;
      const rows = await getSalesRegister({ companyId: user.activeCompany.id, from, to, reference });

      return buildWorkbook({
        companyName: user.activeCompany.name,
        timeZone: user.activeCompany.timezone,
        title: 'Sales Report',
        subtitle: from && to ? period(from, to) : from ? `from ${asDay(from)}` : to ? `up to ${asDay(to)}` : 'All time',
        rows,
        totals: ['Total USD', 'Cost USD', 'Gross profit USD'],
        columns: [
          { header: 'Date', value: (r) => r.invoiceDate, type: 'date' },
          { header: 'Invoice', value: (r) => shortDocumentNumber(r.invoiceNumber) },
          { header: 'Customer', value: (r) => r.customerName, width: 30 },
          { header: 'ICUL/FID Ref', value: (r) => r.references.join(', '), width: 24 },
          { header: 'KG', value: (r) => Number(r.quantityKg), type: 'quantity' },
          { header: 'Currency', value: (r) => r.currency },
          { header: 'Total', value: (r) => Number(r.total), type: 'money' },
          { header: 'Paid', value: (r) => Number(r.settled), type: 'money' },
          { header: 'Outstanding', value: (r) => Number(r.outstanding), type: 'money' },
          { header: 'Total USD', value: (r) => Number(r.totalUsd), type: 'money' },
          // As on screen: cost and profit only for those who may see profit.
          ...(can(user, PERMISSIONS.PROFITS_VIEW)
            ? [
                { header: 'Cost USD', value: (r: (typeof rows)[number]) => Number(r.costOfGoodsUsd), type: 'money' as const },
                { header: 'Gross profit USD', value: (r: (typeof rows)[number]) => Number(r.grossProfitUsd), type: 'money' as const },
              ]
            : []),
          { header: 'Status', value: (r) => r.status },
        ],
      });
    },
  },

  'purchase-register': {
    title: 'Purchase Report',
    permission: PERMISSIONS.REPORTS_VIEW,
    build: async (user, query) => {
      const from = dateParam(query, 'from');
      const to = dateParam(query, 'to');
      const rows = await getPurchaseRegister({ companyId: user.activeCompany.id, from, to });

      return buildWorkbook({
        companyName: user.activeCompany.name,
        timeZone: user.activeCompany.timezone,
        title: 'Purchase Report',
        subtitle: from && to ? period(from, to) : from ? `from ${asDay(from)}` : to ? `up to ${asDay(to)}` : 'All time',
        rows,
        totals: ['Total USD'],
        columns: [
          { header: 'Date', value: (r) => r.contractDate, type: 'date' },
          { header: 'Reference', value: (r) => r.contractReference },
          { header: 'Supplier', value: (r) => r.vendorName, width: 30 },
          { header: 'Origin', value: (r) => r.origin ?? '' },
          { header: 'Bought KG', value: (r) => Number(r.quantityKg), type: 'quantity' },
          { header: 'Landed KG', value: (r) => Number(r.receivedKg), type: 'quantity' },
          { header: 'Currency', value: (r) => r.currency },
          { header: 'Goods', value: (r) => Number(r.goodsValue), type: 'money' },
          { header: 'Freight', value: (r) => Number(r.freight), type: 'money' },
          { header: 'Total', value: (r) => Number(r.total), type: 'money' },
          { header: 'Paid', value: (r) => Number(r.settled), type: 'money' },
          { header: 'Outstanding', value: (r) => Number(r.outstanding), type: 'money' },
          { header: 'Total USD', value: (r) => Number(r.totalUsd), type: 'money' },
          { header: 'Status', value: (r) => r.status },
        ],
      });
    },
  },

  'trial-balance': {
    title: 'Trial Balance',
    permission: PERMISSIONS.ACCOUNTING_VIEW,
    build: async (user, query) => {
      // The screen's report exactly: each account's debit or credit balance
      // as at one date, the same filters, account names and rows.
      const companyId = user.activeCompany.id;
      const to = dateParam(query, 'asOf') ?? dateParam(query, 'to') ?? new Date();
      const local = user.activeCompany.localCurrency;
      const filters = {
        accountType: query.get('type') || null,
        currency: query.get('currency') || null,
        customerId: query.get('customer') || null,
        vendorId: query.get('vendor') || null,
        warehouseId: query.get('warehouse') || null,
        shipmentId: query.get('shipment') || null,
      };
      const filtered = Object.values(filters).some(Boolean);
      const [trial, accounts] = await Promise.all([
        getTrialBalanceReport({ companyId, to, filters }),
        prisma.account.findMany({ where: { companyId }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, type: true, systemKey: true } }),
      ]);
      const meta = new Map(accounts.map((a) => [a.id, { systemKey: a.systemKey }]));
      const listed = new Set(trial.rows.map((r) => r.accountId));
      const zero = dec(0);
      const rows = query.get('view') === 'all' && !filtered
        ? [
            ...trial.rows,
            ...accounts.filter((a) => !listed.has(a.id)).map((a) => ({
              accountId: a.id, code: a.code, name: a.name, type: a.type as string,
              debitUsd: zero, creditUsd: zero, debitLocal: zero, creditLocal: zero,
              openingDebitUsd: zero, openingCreditUsd: zero, periodDebitUsd: zero, periodCreditUsd: zero,
              openingDebitLocal: zero, openingCreditLocal: zero, periodDebitLocal: zero, periodCreditLocal: zero,
            })),
          ].sort((x, y) => x.code.localeCompare(y.code))
        : trial.rows.filter((r) => !isUnusedInPeriod(r));
      const scope = filtered ? ' · FILTERED: only the lines matching the filters, so the totals are of those lines' : '';

      return buildWorkbook({
        companyName: user.activeCompany.name,
        timeZone: user.activeCompany.timezone,
        title: 'Trial Balance',
        subtitle: `${asAt(to)}${scope}${trial.isBalancedLocal || filtered ? '' : ' — OUT OF BALANCE'}`,
        rows: rows.map((r) => ({ ...r, label: clientLabel(r, meta.get(r.accountId)) })),
        totals: [`Debit ${local}`, `Credit ${local}`],
        columns: [
          { header: 'Account', value: (r) => r.label, width: 38 },
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

      // As on screen: the Cost of Goods Sold line opened into the coffee and
      // each shipment expense on the coffee sold, adding up to the ledger.
      const [breakdown, cogsAccount] = await Promise.all([
        getCostOfSalesBreakdown({ companyId: user.activeCompany.id, from, to }),
        prisma.account.findFirst({ where: { companyId: user.activeCompany.id, systemKey: 'COST_OF_GOODS_SOLD' }, select: { id: true } }),
      ]);
      // As on screen, the shipment expenses on the coffee sold are listed with
      // the operating expenses; the books keep them in the coffee's cost.
      const ledgerCogs = pnl.costOfSales.find((l) => l.accountId === cogsAccount?.id);
      const moved = ledgerCogs ? breakdown.expensesTotal : { local: dec(0), usd: dec(0) };
      const cogsLocal = t.costOfSalesLocal.minus(moved.local);
      const cogsUsd = t.costOfSalesUsd.minus(moved.usd);
      const opexLocal = t.operatingExpensesLocal.plus(moved.local);
      const opexUsd = t.operatingExpensesUsd.plus(moved.usd);
      const grossLocal = t.grossProfitLocal.plus(moved.local);
      const grossUsd = t.grossProfitUsd.plus(moved.usd);
      const cogsRows = pnlSection('Less: Cost of Goods Sold', pnl.costOfSales, { usd: cogsUsd, local: cogsLocal }, 'Total Cost of Goods Sold');
      const expenseRows = pnlSection('Less: Operating Expenses', pnl.operatingExpenses, { usd: opexUsd, local: opexLocal }, 'Total Operating Expenses');
      if (ledgerCogs) {
        const timingLocal = dec(ledgerCogs.amountLocal).minus(breakdown.totalLocal);
        const timingUsd = dec(ledgerCogs.amountUsd).minus(breakdown.totalUsd);
        const parts: StatementRow[] = [
          { kind: 'line', label: 'Coffee purchase cost (coffee sold)', values: [Number(breakdown.purchase.local), Number(breakdown.purchase.usd)] },
          ...(timingLocal.abs().greaterThanOrEqualTo('0.01')
            ? [{ kind: 'line', label: 'Stock / cost of sales correction dated in this period', values: [Number(timingLocal), Number(timingUsd)] } as StatementRow]
            : []),
        ];
        const at = cogsRows.findIndex((r) => r.kind === 'line' && r.label === ledgerCogs.name);
        if (at >= 0) cogsRows.splice(at, 1, ...parts);
        // After the section heading, before the other expense accounts.
        expenseRows.splice(
          1,
          0,
          ...breakdown.expenses.map((e): StatementRow => ({ kind: 'line', label: `Shipment expense — ${e.label}`, values: [Number(e.local), Number(e.usd)] })),
        );
      }

      const pair = (local: unknown, usd: unknown) => [Number(local), Number(usd)];
      const rows: StatementRow[] = [
        // The requirements' statement first, one line per heading, as on screen.
        { kind: 'section', label: 'Profit & Loss (P&L)' },
        { kind: 'line', label: 'Sales / Revenue', values: pair(t.revenueLocal, t.revenueUsd) },
        { kind: 'line', label: 'Less: Cost of Goods Sold', values: pair(cogsLocal, cogsUsd) },
        { kind: 'total', label: 'Gross Profit', values: pair(grossLocal, grossUsd) },
        { kind: 'line', label: 'Less: Operating Expenses', values: pair(opexLocal, opexUsd) },
        { kind: 'line', label: 'Other Income / Expenses', values: pair(t.otherLocal, t.otherUsd) },
        { kind: 'total', label: 'Net Profit / Loss', values: pair(t.netProfitLocal, t.netProfitUsd) },
        { kind: 'spacer' },
        { kind: 'section', label: 'What each heading is made of' },
        { kind: 'spacer' },
        // The headings the statement on screen uses, so the file and the
        // screen read as one report rather than two namings of it.
        ...pnlSection('Sales / Revenue', pnl.revenue, { usd: t.revenueUsd, local: t.revenueLocal }, 'Total Sales / Revenue'),
        ...cogsRows,
        {
          kind: 'total',
          label: 'Gross Profit',
          values: [Number(grossLocal), Number(grossUsd)],
        },
        { kind: 'note', label: `Gross margin ${t.revenueLocal.isZero() ? '0.0' : grossLocal.dividedBy(t.revenueLocal).times(100).toFixed(1)}% of revenue` },
        { kind: 'spacer' },
        ...expenseRows,
      ];

      if (pnl.otherItems.length > 0) {
        rows.push(...pnlSection('Other Income / Expenses', pnl.otherItems, { usd: t.otherUsd, local: t.otherLocal }, 'Total Other Income / Expenses'));
      }

      rows.push(
        { kind: 'grand', label: 'Net Profit / Loss', values: [Number(t.netProfitLocal), Number(t.netProfitUsd)] },
        { kind: 'note', label: `Net margin ${Number(pnl.netMarginPct).toFixed(1)}% of revenue` },
      );

      return buildStatementWorkbook({
        companyName: user.activeCompany.name,
        timeZone: user.activeCompany.timezone,
        title: 'Profit and Loss',
        subtitle: period(from, to),
        labelHeader: 'Account',
        columns: [
          { header: local, type: 'money' },
          { header: 'USD equivalent', type: 'money' },
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

      // Under the headings of the client's requirements document, as on screen.
      const grouped = (title: string, groups: readonly string[], section: typeof sheet.assets): StatementRow[] => [
        { kind: 'section', label: title },
        ...groups.flatMap((group): StatementRow[] => {
          // Every heading the requirements list, empty or not.
          const lines = section.lines.filter((l) => l.group === group);
          return [
            { kind: 'note', label: group },
            ...lines.map((line): StatementRow => ({ kind: 'line', label: line.displayName, code: line.code, values: [Number(line.amountLocal), Number(line.amountUsd)] })),
            {
              kind: 'total',
              label: `Total ${group}`,
              values: [Number(sum(lines.map((l) => l.amountLocal))), Number(sum(lines.map((l) => l.amountUsd)))],
            },
          ];
        }),
        { kind: 'total', label: `Total ${title}`, values: [Number(section.totalLocal), Number(section.totalUsd)] },
        { kind: 'spacer' },
      ];
      const rows: StatementRow[] = [
        ...grouped('Assets', BALANCE_SHEET_GROUPS.ASSET, sheet.assets),
        ...grouped('Liabilities', BALANCE_SHEET_GROUPS.LIABILITY, sheet.liabilities),
        ...grouped('Equity', BALANCE_SHEET_GROUPS.EQUITY, sheet.equity),
        {
          kind: 'grand',
          label: 'Total Liabilities plus Total Equity',
          values: [
            Number(sheet.liabilities.totalLocal.plus(sheet.equity.totalLocal)),
            Number(sheet.liabilities.totalUsd.plus(sheet.equity.totalUsd)),
          ],
        },
      ];

      // Say so on the sheet itself. A balance sheet that does not balance is
      // the one thing a reader must not have to work out for themselves.
      rows.push({
        kind: 'note',
        label: sheet.balancesLocal
          ? 'Balance check: Total Assets equal Total Liabilities plus Total Equity.'
          : `OUT OF BALANCE by ${local} ${sheet.differenceLocal.toFixed(2)} — this needs investigating.`,
      });

      return buildStatementWorkbook({
        companyName: user.activeCompany.name,
        timeZone: user.activeCompany.timezone,
        title: 'Balance Sheet',
        subtitle: asAt(asOf),
        labelHeader: 'Account',
        columns: [
          { header: local, type: 'money' },
          { header: 'USD equivalent', type: 'money' },
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
        timeZone: user.activeCompany.timezone,
        title: 'Cash Flow',
        subtitle: period(from, to),
        labelHeader: 'Movement',
        columns: [
          { header: `In ${user.activeCompany.localCurrency}`, type: 'money' },
          { header: `Out ${user.activeCompany.localCurrency}`, type: 'money' },
          { header: `Net ${user.activeCompany.localCurrency}`, type: 'money' },
          { header: 'In USD', type: 'money' },
          { header: 'Out USD', type: 'money' },
          { header: 'Net USD', type: 'money' },
        ],
        rows: [
          { kind: 'section', label: 'Money in and out of cash and bank' },
          ...flow.lines.map((line): StatementRow => ({
            kind: 'line',
            label: line.label,
            values: [Number(line.inLocal), Number(line.outLocal), Number(line.netLocal), Number(line.inUsd), Number(line.outUsd), Number(line.netUsd)],
          })),
          {
            kind: 'grand',
            label: 'Net movement',
            values: [
              Number(flow.totalInLocal), Number(flow.totalOutLocal), Number(flow.netMovementLocal),
              Number(flow.totalInUsd), Number(flow.totalOutUsd), Number(flow.netMovementUsd),
            ],
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

      // Labelled in the currency the ledger was read in. The balance runs in
      // that currency — dirhams for a MAD drawer or the company view — and a
      // sheet that called it "USD" put MAD 174,273.48 of cash under a USD
      // heading, with totals taken from the historical USD columns instead.
      const ccy = ledger.displayCurrency;
      const listed = ledger.mixedCurrencies;
      type GlRow = (typeof ledger.rows)[number];
      return buildWorkbook({
        companyName: user.activeCompany.name,
        timeZone: user.activeCompany.timezone,
        title: 'General Ledger',
        subtitle: listed
          ? `${ledger.account.name} · every currency listed separately, never added together`
          : `${ledger.account.name} · opening ${ccy} ${Number(ledger.openingBalance).toFixed(2)}` +
            ` · closing ${ccy} ${Number(ledger.closingBalance).toFixed(2)}`,
        rows: ledger.rows,
        totals: listed ? [] : ledger.viewCurrency === 'REPORTING' ? ['Debit USD', 'Credit USD'] : [`Debit ${ccy}`, `Credit ${ccy}`],
        columns: [
          { header: 'Date', value: (r) => r.entryDate, type: 'date' },
          { header: 'Source', value: (r) => r.sourceType.replace(/_/g, ' ') },
          { header: 'Memo', value: (r) => r.description, width: 40 },
          { header: 'Reference', value: (r) => r.reference ?? '', width: 28 },
          { header: 'Currency', value: (r) => r.currency, width: 10 },
          ...(ledger.viewCurrency === 'REPORTING' || listed
            ? [
                { header: 'Debit', value: (r: GlRow) => Number(r.debit), type: 'money' as const },
                { header: 'Credit', value: (r: GlRow) => Number(r.credit), type: 'money' as const },
              ]
            : [
                { header: `Debit ${ccy}`, value: (r: GlRow) => Number(r.debit), type: 'money' as const },
                { header: `Credit ${ccy}`, value: (r: GlRow) => Number(r.credit), type: 'money' as const },
              ]),
          ...(ccy === 'USD' && ledger.viewCurrency !== 'REPORTING' && !listed
            ? []
            : [
                { header: 'Debit USD', value: (r: GlRow) => Number(r.debitUsd), type: 'money' as const },
                { header: 'Credit USD', value: (r: GlRow) => Number(r.creditUsd), type: 'money' as const },
              ]),
          ...(listed ? [] : [{ header: `Balance ${ccy}`, value: (r: GlRow) => Number(r.balance), type: 'money' as const }]),
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
          currency: line.currency,
          debit: Number(line.debit),
          credit: Number(line.credit),
          debitLocal: Number(line.debitLocal),
          creditLocal: Number(line.creditLocal),
          debitUsd: Number(line.debitUsd),
          creditUsd: Number(line.creditUsd),
        })),
      );
      // The same three readings the screen shows: as raised, in the company's
      // currency (what the books balance in), and the USD equivalent.
      const local = user.activeCompany.localCurrency;

      return buildWorkbook({
        companyName: user.activeCompany.name,
        timeZone: user.activeCompany.timezone,
        title: 'Journal',
        subtitle:
          (from && to ? `${period(from, to)} · ` : '') +
          `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, ${rows.length} lines`,
        rows,
        totals: [`Debit ${local}`, `Credit ${local}`, 'Debit USD', 'Credit USD'],
        columns: [
          { header: 'Date', value: (r) => r.entryDate, type: 'date' },
          { header: 'Source', value: (r) => r.sourceType.replace(/_/g, ' ') },
          { header: 'Narration', value: (r) => r.narration, width: 38 },
          { header: 'Account', value: (r) => r.accountName, width: 32 },
          { header: 'Line detail', value: (r) => r.lineDescription, width: 32 },
          { header: 'Currency', value: (r) => r.currency, width: 10 },
          { header: 'Debit', value: (r) => r.debit, type: 'money' },
          { header: 'Credit', value: (r) => r.credit, type: 'money' },
          { header: `Debit ${local}`, value: (r) => r.debitLocal, type: 'money' },
          { header: `Credit ${local}`, value: (r) => r.creditLocal, type: 'money' },
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
      // The company's own currency first, as on the screen; USD beside it.
      const local = user.activeCompany.localCurrency;
      const total = Number(rows.reduce((sum, row) => sum.plus(dec(row.amountLocal)), dec(0)));

      return buildWorkbook({
        companyName: user.activeCompany.name,
        timeZone: user.activeCompany.timezone,
        title: 'Expense Report',
        subtitle: `${period(from, to)} · grouped by ${groupBy}`,
        rows: rows.map((row) => ({
          ...row,
          share: total === 0 ? 0 : Number(row.amountLocal) / total,
        })),
        totals: [`Amount ${local}`, 'Amount USD', 'Entries'],
        columns: [
          { header: titleFor(groupBy), value: (r) => r.label, width: 40 },
          { header: 'Entries', value: (r) => r.count, type: 'integer' },
          { header: `Amount ${local}`, value: (r) => Number(r.amountLocal), type: 'money' },
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
        timeZone: user.activeCompany.timezone,
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
        timeZone: user.activeCompany.timezone,
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
            values: [null, '', Number(position.accounts.reduce((sum, a) => sum.plus(a.balanceUsd), dec(0)))],
          },
          { kind: 'spacer' },
          { kind: 'section', label: 'Owed to and by the business' },
          { kind: 'line', label: 'Customer receivables', values: [null, '', Number(position.receivableUsd)] },
          { kind: 'line', label: 'Supplier payables', values: [null, '', -Number(position.payableUsd)] },
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
        timeZone: user.activeCompany.timezone,
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
        timeZone: user.activeCompany.timezone,
        title: 'Forex Gain / Loss',
        subtitle: `${period(from, to)} · net USD ${Number(report.netUsd).toFixed(2)} (positive is a loss)`,
        rows: report.rows,
        totals: ['Loss USD', 'Gain USD', `Loss ${local}`, `Gain ${local}`],
        columns: [
          { header: 'Date', value: (r) => r.entryDate, type: 'date' },
          { header: 'Source', value: (r) => r.sourceType.replaceAll('_', ' ') },
          { header: 'Memo', value: (r) => r.description, width: 40 },
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
      const local = user.activeCompany.localCurrency;
      const showLocal = showCost && local !== 'USD';
      return buildWorkbook({
        companyName: user.activeCompany.name,
        timeZone: user.activeCompany.timezone,
        title: 'Inventory Valuation',
        subtitle: showCost
          ? 'On-hand stock at each batch landed cost'
          : 'On-hand quantities. Cost figures are not part of your access.',
        rows,
        totals: showCost
          ? ['On hand (KG)', 'Available (KG)', ...(showLocal ? [`Value (${local})`] : []), 'Value (USD)']
          : ['On hand (KG)', 'Available (KG)'],
        columns: [
          { header: 'Warehouse', value: (r) => r.warehouseName, width: 26 },
          { header: 'Code', value: (r) => r.warehouseCode },
          { header: 'Coffee', value: (r) => r.itemName, width: 28 },
          { header: 'Batch', value: (r) => r.batchNumber },
          { header: 'Lot', value: (r) => r.lotNumber },
          { header: 'Container', value: (r) => r.containerNumber ?? '' },
          { header: 'On hand (KG)', value: (r) => Number(r.onHandKg), type: 'quantity' },
          { header: 'Available (KG)', value: (r) => Number(r.availableKg), type: 'quantity' },
          ...(showLocal
            ? [
                { header: `Landed / KG (${local})`, value: (r: (typeof rows)[number]) => Number(r.landedUnitCostLocal), type: 'money' as const },
                { header: `Value (${local})`, value: (r: (typeof rows)[number]) => Number(r.valueLocal), type: 'money' as const },
              ]
            : []),
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
      const local = user.activeCompany.localCurrency;
      const localColumns =
        local === 'USD'
          ? []
          : [
              { header: `Revenue (${local})`, value: (r: (typeof rows)[number]) => Number(r.revenueLocal), type: 'money' as const },
              { header: `COGS (${local})`, value: (r: (typeof rows)[number]) => Number(r.cogsLocal), type: 'money' as const },
              { header: `Gross profit (${local})`, value: (r: (typeof rows)[number]) => Number(r.grossProfitLocal), type: 'money' as const },
            ];
      return buildWorkbook({
        companyName: user.activeCompany.name,
        timeZone: user.activeCompany.timezone,
        title: 'Cost of Goods Sold',
        subtitle: period(from, to),
        rows,
        totals: ['Quantity (KG)', ...localColumns.map((c) => c.header), 'Revenue (USD)', 'COGS (USD)', 'Gross profit (USD)'],
        columns: [
          { header: 'Date', value: (r) => r.invoiceDate, type: 'date' },
          { header: 'Customer', value: (r) => r.customerName, width: 28 },
          { header: 'Coffee', value: (r) => r.itemName, width: 28 },
          { header: 'ICUL/FID Ref', value: (r) => r.contractReference },
          { header: 'Batch', value: (r) => r.batchNumber },
          { header: 'Warehouse', value: (r) => r.warehouseName ?? '' },
          { header: 'Quantity (KG)', value: (r) => Number(r.quantityKg), type: 'quantity' },
          ...localColumns,
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
        timeZone: user.activeCompany.timezone,
        title: 'Agent Commission',
        subtitle: 'Commission agreed on a shipment, whether or not it has been paid',
        rows,
        totals: ['Amount USD', 'Paid USD', 'Outstanding USD'],
        columns: [
          { header: 'Date', value: (r) => r.expenseDate, type: 'date' },
          { header: 'Agent', value: (r) => r.agentName, width: 26 },
          { header: 'Contract ref', value: (r) => r.contractReference ?? '', width: 22 },
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
        timeZone: user.activeCompany.timezone,
        title: `Statement — ${data.customer.customerName}`,
        subtitle: `${data.customer.customerName} · ${data.view} · ${range}`,
        rows: data.ledger.rows,
        columns: [
          { header: 'Date', value: (r) => r.entryDate, type: 'date' },
          { header: 'Type', value: (r) => r.sourceType.replaceAll('_', ' ') },
          { header: 'Reference', value: (r) => r.reference ?? '' },
          { header: 'Memo', value: (r) => r.description, width: 40 },
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
        timeZone: user.activeCompany.timezone,
        title: `Statement — ${data.vendor.vendorName}`,
        subtitle: `${data.vendor.vendorName} · ${data.view} · ${range}`,
        rows: data.ledger.rows,
        columns: [
          { header: 'Date', value: (r) => r.entryDate, type: 'date' },
          { header: 'Type', value: (r) => r.sourceType.replaceAll('_', ' ') },
          { header: 'Reference', value: (r) => r.reference ?? '' },
          { header: 'Memo', value: (r) => r.description, width: 40 },
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
    // Exporting is a permission of its own ("Export reports and lists"). The
    // screens hid the buttons; the address could still be typed.
    if (!can(user, PERMISSIONS.REPORTS_EXPORT)) {
      throw new ForbiddenError('You do not have permission to export reports. Ask an administrator to allow it.');
    }

    if (query.get('format') === 'csv') {
      /*
       * Every report can be had as CSV, not only the two that were written by
       * hand. Where a report defines its own rows they are used; otherwise the
       * workbook is built and read back, so the CSV is whatever the Excel file
       * says rather than a second definition that can drift from it.
       */
      let body: Buffer;
      if (definition.csv) {
        const { headers, rows } = await definition.csv(user, query);
        body = buildCsv(headers, rows);
      } else {
        body = await csvFromWorkbook(await definition.build(user, query));
      }
      return new NextResponse(new Uint8Array(body), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Length': String(body.byteLength),
          'Content-Disposition': `attachment; filename="${workbookFileName(definition.title, user.activeCompany.code, 'csv', user.activeCompany.timezone)}"`,
          'Cache-Control': 'private, no-store',
        },
      });
    }

    const workbook = await definition.build(user, query);

    return new NextResponse(new Uint8Array(workbook), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Length': String(workbook.byteLength),
        'Content-Disposition': `attachment; filename="${workbookFileName(definition.title, user.activeCompany.code, 'xlsx', user.activeCompany.timezone)}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    const response = toErrorResponse(error);
    return NextResponse.json({ error: response.message }, { status: response.status ?? 400 });
  }
}
