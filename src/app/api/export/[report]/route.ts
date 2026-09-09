import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { toErrorResponse, NotFoundError } from '@/lib/errors';
import { buildWorkbook, workbookFileName } from '@/lib/services/workbook';
import { getLoadingSheet } from '@/lib/services/loading-sheet';
import { getReceivables, getPayables } from '@/lib/services/receivables';
import { getBatchStock } from '@/lib/services/stock';
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
  build: (user: SessionUser) => Promise<Buffer>;
};

const REPORTS: Record<string, Report> = {
  'loading-sheet': {
    title: 'Loading Follow-Up',
    permission: PERMISSIONS.SHIPMENTS_VIEW,
    build: async (user) => {
      const rows = await getLoadingSheet(user.activeCompany.id);
      const isDubai = user.activeCompany.localCurrency === 'AED';

      return buildWorkbook({
        companyName: user.activeCompany.name,
        title: 'Loading Follow-Up',
        subtitle: `${rows.length} container${rows.length === 1 ? '' : 's'} on the book`,
        rows: rows.map((row, index) => ({ ...row, serial: index + 1 })),
        totals: ['Quantity (KG)', 'Sold (KG)', 'Available (KG)'],
        columns: [
          { header: 'S/No', value: (r) => r.serial, type: 'integer', width: 7 },
          { header: 'Contract date', value: (r) => r.contractDate, type: 'date' },
          { header: 'Contract ref', value: (r) => r.contractReference },
          { header: 'FID number', value: (r) => r.contractNumber },
          { header: isDubai ? 'Exporter' : 'Company name', value: (r) => r.exporter },
          { header: 'Importer', value: (r) => r.importer },
          { header: 'Consignee', value: (r) => r.consignee ?? '' },
          { header: 'Items description', value: (r) => r.itemName },
          { header: 'Lot', value: (r) => r.lotNumber },
          { header: 'Batch', value: (r) => r.batchNumber },
          { header: 'Quantity (KG)', value: (r) => Number(r.quantityKg), type: 'quantity' },
          { header: 'Sold (KG)', value: (r) => Number(r.soldKg), type: 'quantity' },
          { header: 'Available (KG)', value: (r) => Number(r.availableKg), type: 'quantity' },
          { header: 'Origin', value: (r) => r.origin },
          { header: 'Destination', value: (r) => r.destination ?? '' },
          { header: 'Status', value: (r) => r.status.replace(/_/g, ' ') },
          { header: 'Containers', value: (r) => r.containers, type: 'integer' },
          { header: 'Container no.', value: (r) => r.containerNumber ?? '' },
          { header: 'B/L', value: (r) => r.billOfLading ?? '' },
          { header: 'Shipping line', value: (r) => r.shippingLine ?? '' },
          { header: 'ETA', value: (r) => r.etaDate ?? '', type: 'date' },
          { header: 'Sale status', value: (r) => r.saleStatus.replace(/_/g, ' ') },
          { header: 'Payment', value: (r) => (r.paymentStatus === 'NONE' ? '' : r.paymentStatus) },
          { header: 'Documents', value: (r) => r.documentStatus.replace(/_/g, ' ') },
          { header: 'Remarks', value: (r) => r.remarks ?? '', width: 32 },
        ],
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
      const rows = sheet.flatMap((row) =>
        row.allocations.length === 0
          ? [{
              contractReference: row.contractReference,
              contractNumber: row.contractNumber,
              batchNumber: row.batchNumber,
              itemName: row.itemName,
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
              batchNumber: row.batchNumber,
              itemName: row.itemName,
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
};

export async function GET(_request: Request, context: { params: Promise<{ report: string }> }) {
  try {
    const { report } = await context.params;
    const definition = REPORTS[report];
    if (!definition) throw new NotFoundError('Report');

    const user = await requirePermission(definition.permission as never);
    const workbook = await definition.build(user);

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
