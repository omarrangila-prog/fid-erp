import 'server-only';
import { prisma } from '@/lib/db';
import { dec, toMoney } from '@/lib/money';
import { formatMoney, formatDate, formatQuantityKg } from '@/lib/format';
import { getTaxSettings, listTaxCodes } from '@/lib/services/tax';
import { getRateDefaults } from '@/lib/services/exchange-rate';
import type { CreditNoteRow } from '@/components/credit-notes/credit-notes-client';
import type {
  CreditParty,
  CreditDocument,
  CreditStock,
  CreditTaxCode,
} from '@/components/credit-notes/credit-note-form';

/**
 * Data for the credit-note screens.
 *
 * Customer credits and supplier debits are the same document in opposite
 * directions, so both screens are built from these three loaders rather than
 * two near-identical copies that would drift apart.
 */

export async function loadCreditNoteRows(
  companyId: string,
  type: 'CUSTOMER' | 'VENDOR',
): Promise<CreditNoteRow[]> {
  const notes = await prisma.creditNote.findMany({
    where: { companyId, type },
    orderBy: [{ creditDate: 'desc' }, { creditNoteNumber: 'desc' }],
    include: {
      customer: { select: { customerName: true } },
      vendor: { select: { vendorName: true } },
      salesInvoice: { select: { invoiceNumber: true } },
      purchaseContract: { select: { contractNumber: true } },
      lines: { select: { batchId: true } },
    },
  });

  return notes.map((note) => ({
    id: note.id,
    number: note.creditNoteNumber,
    date: formatDate(note.creditDate),
    dateSort: note.creditDate.getTime(),
    party: note.customer?.customerName ?? note.vendor?.vendorName ?? '—',
    againstDocument: note.salesInvoice?.invoiceNumber ?? note.purchaseContract?.contractNumber ?? null,
    reason: note.reason,
    currency: note.currency,
    netLabel: formatMoney(note.subtotalAmount, note.currency),
    taxLabel: dec(note.taxAmount).greaterThan(0) ? formatMoney(note.taxAmount, note.currency) : null,
    totalLabel: formatMoney(note.totalAmount, note.currency),
    totalSort: Number(note.totalAmountUsd),
    returnsStock: note.lines.some((line) => line.batchId !== null),
    status: note.status,
  }));
}

export async function loadCreditNoteFormData(companyId: string, type: 'CUSTOMER' | 'VENDOR') {
  const taxSettings = await getTaxSettings(companyId);

  const [rates, parties, warehouses, taxCodes, company] = await Promise.all([
    getRateDefaults(companyId),
    type === 'CUSTOMER'
      ? prisma.customer
          .findMany({
            where: { companyId, status: 'ACTIVE' },
            orderBy: { customerName: 'asc' },
            select: { id: true, customerName: true, primaryCurrency: true },
          })
          .then((rows) => rows.map((r) => ({ id: r.id, name: r.customerName, currency: r.primaryCurrency })))
      : prisma.vendor
          .findMany({
            where: { companyId, status: 'ACTIVE' },
            orderBy: { vendorName: 'asc' },
            select: { id: true, vendorName: true, primaryCurrency: true },
          })
          .then((rows) => rows.map((r) => ({ id: r.id, name: r.vendorName, currency: r.primaryCurrency }))),
    prisma.warehouse.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    taxSettings.enabled ? listTaxCodes(companyId, type === 'CUSTOMER' ? 'SALES' : 'PURCHASE') : Promise.resolve([]),
    prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { localCurrency: true } }),
  ]);

  // Documents, each with what is left to credit after any posted notes.
  const documents: CreditDocument[] =
    type === 'CUSTOMER'
      ? await prisma.salesInvoice
          .findMany({
            where: { companyId, status: 'POSTED' },
            orderBy: { invoiceDate: 'desc' },
            take: 300,
            select: {
              id: true,
              invoiceNumber: true,
              customerId: true,
              currency: true,
              totalAmount: true,
              totalAmountUsd: true,
              creditNotes: { where: { status: 'POSTED' }, select: { totalAmountUsd: true, totalAmount: true } },
            },
          })
          .then((rows) =>
            rows.map((row) => {
              const credited = row.creditNotes.reduce((sum, note) => sum.plus(note.totalAmount), dec(0));
              return {
                id: row.id,
                number: row.invoiceNumber,
                partyId: row.customerId,
                currency: row.currency,
                totalLabel: formatMoney(row.totalAmount, row.currency),
                headroomLabel: formatMoney(toMoney(dec(row.totalAmount).minus(credited)), row.currency),
              };
            }),
          )
      : await prisma.purchaseContract
          .findMany({
            where: { companyId, status: 'POSTED' },
            orderBy: { contractDate: 'desc' },
            take: 300,
            select: {
              id: true,
              contractNumber: true,
              vendorId: true,
              currency: true,
              totalValue: true,
              taxAmount: true,
              creditNotes: { where: { status: 'POSTED' }, select: { totalAmount: true } },
            },
          })
          .then((rows) =>
            rows.map((row) => {
              const gross = dec(row.totalValue).plus(row.taxAmount);
              const credited = row.creditNotes.reduce((sum, note) => sum.plus(note.totalAmount), dec(0));
              return {
                id: row.id,
                number: row.contractNumber,
                partyId: row.vendorId,
                currency: row.currency,
                totalLabel: formatMoney(gross, row.currency),
                headroomLabel: formatMoney(toMoney(gross.minus(credited)), row.currency),
              };
            }),
          );

  // Only batches that have actually sold can be credited back into stock.
  //
  // The lot and container come along so a whole consignment can be returned in
  // one action: coffee comes back by the container far more often than by the
  // individual batch, and making somebody add fourteen lines by hand is how a
  // return gets recorded wrongly or not at all.
  //
  // The price and warehouse are taken from the most recent posted sale of that
  // batch, so the credit defaults to undoing the sale rather than inventing a
  // new price.
  const stock: CreditStock[] =
    type === 'CUSTOMER'
      ? await prisma.$queryRaw<
          Array<{
            batchId: string;
            batchNumber: string;
            itemName: string;
            lotNumber: string | null;
            containerNumber: string | null;
            soldKg: string;
            landedUnitCostUsd: string;
            lastUnitPriceKg: string | null;
            lastWarehouseId: string | null;
            lastCustomerId: string | null;
          }>
        >`
          SELECT b."id" AS "batchId",
                 b."batchNumber",
                 ci."itemName",
                 l."lotNumber",
                 c."containerNumber",
                 b."soldQuantityKg"::text AS "soldKg",
                 b."landedUnitCostUsd"::text AS "landedUnitCostUsd",
                 last_sale."unitPriceKg"::text AS "lastUnitPriceKg",
                 last_sale."warehouseId" AS "lastWarehouseId",
                 last_sale."customerId" AS "lastCustomerId"
          FROM batches b
          JOIN coffee_items ci ON ci."id" = b."itemId"
          LEFT JOIN lots l ON l."id" = b."lotId"
          LEFT JOIN containers c ON c."id" = b."containerId"
          LEFT JOIN LATERAL (
            SELECT sil."unitPriceKg", sil."warehouseId", si."customerId"
            FROM sales_invoice_lines sil
            JOIN sales_invoices si ON si."id" = sil."salesInvoiceId"
            WHERE sil."batchId" = b."id" AND si."status" = 'POSTED'
            ORDER BY si."invoiceDate" DESC, si."invoiceNumber" DESC
            LIMIT 1
          ) last_sale ON true
          WHERE b."companyId" = ${companyId}
            AND b."soldQuantityKg" > 0
          ORDER BY c."containerNumber" NULLS LAST, l."lotNumber" NULLS LAST, b."batchNumber"`
      : [];

  const taxCodeOptions: CreditTaxCode[] = taxCodes.map((code) => ({
    id: code.id,
    code: code.code,
    name: code.name,
    ratePct: code.ratePct.toString(),
  }));

  return {
    parties: parties as CreditParty[],
    documents,
    stock,
    warehouses,
    taxCodes: taxCodeOptions,
    taxLabel: taxSettings.label,
    taxEnabled: taxSettings.enabled,
    localCurrency: company.localCurrency,
    defaultRateLocalPerUsd: rates.local,
  };
}

export async function loadCreditNoteDetail(companyId: string, id: string) {
  const note = await prisma.creditNote.findFirst({
    where: { id, companyId },
    include: {
      customer: { select: { customerName: true, primaryCurrency: true } },
      vendor: { select: { vendorName: true, primaryCurrency: true } },
      salesInvoice: { select: { id: true, invoiceNumber: true } },
      purchaseContract: { select: { id: true, contractNumber: true } },
      createdBy: { select: { name: true } },
      postedBy: { select: { name: true } },
      lines: {
        orderBy: { lineNumber: 'asc' },
        include: {
          batch: { select: { batchNumber: true } },
          warehouse: { select: { name: true } },
          taxCode: { select: { code: true, name: true } },
        },
      },
    },
  });
  if (!note) return null;

  return {
    note,
    lineRows: note.lines.map((line) => ({
      id: line.id,
      lineNumber: line.lineNumber,
      description: line.description,
      batchNumber: line.batch?.batchNumber ?? null,
      warehouseName: line.warehouse?.name ?? null,
      quantityLabel: dec(line.quantityKg).greaterThan(0) ? formatQuantityKg(line.quantityKg) : null,
      unitPriceLabel: dec(line.unitPrice).greaterThan(0) ? formatMoney(line.unitPrice, note.currency) : null,
      taxCodeLabel: line.taxCode ? `${line.taxCode.code}` : null,
      taxLabel: dec(line.taxAmount).greaterThan(0) ? formatMoney(line.taxAmount, note.currency) : null,
      netLabel: formatMoney(line.lineTotal, note.currency),
      totalLabel: formatMoney(toMoney(dec(line.lineTotal).plus(line.taxAmount)), note.currency),
    })),
  };
}
