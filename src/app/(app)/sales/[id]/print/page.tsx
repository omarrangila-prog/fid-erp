import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma, transaction } from '@/lib/db';
import { dec, toMoney } from '@/lib/money';
import { getInvoiceOutstanding } from '@/lib/services/receipt';
import { formatMoney, formatDate, formatQuantityKg, companyFlag } from '@/lib/format';
import { PrintButton } from '@/components/shared/print-button';
import { AutoPrint } from '@/app/(app)/sales/[id]/print/auto-print';

export const metadata: Metadata = { title: 'Invoice' };
export const dynamic = 'force-dynamic';

/**
 * The invoice as a document.
 *
 * This is the page a customer receives, so it is laid out as a commercial
 * invoice rather than as a screen: the parties at the top, the coffee described
 * the way the trade describes it — origin, grade, lot, batch, container — and
 * the money reading down the right. Traceability belongs on the paper: a
 * roaster who has a quality question six months from now needs the lot number
 * on the invoice, not in a system they cannot open.
 */
export default async function InvoicePrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.SALES_VIEW);

  const invoice = await prisma.salesInvoice.findFirst({
    where: { id, companyId: user.activeCompany.id },
    include: {
      customer: true,
      shipment: { select: { jobNumber: true, shipmentNumber: true, billOfLading: true, vesselName: true } },
      lines: {
        orderBy: { lineNumber: 'asc' },
        include: {
          item: { select: { itemName: true, originCountry: true, grade: true, screenSize: true, cropYear: true } },
          batch: { select: { batchNumber: true, lot: { select: { lotNumber: true } } } },
          container: { select: { containerNumber: true } },
        },
      },
    },
  });
  if (!invoice) notFound();

  const company = await prisma.company.findUniqueOrThrow({ where: { id: user.activeCompany.id } });
  const outstanding =
    invoice.status === 'POSTED' ? await transaction((tx) => getInvoiceOutstanding(tx, invoice.id)) : null;

  const totalKg = invoice.lines.reduce((sum, line) => sum.plus(line.quantityKg), dec(0));
  const totalBags = invoice.lines.reduce((sum, line) => sum + line.bags, 0);
  const paid = outstanding ? toMoney(dec(invoice.totalAmount).minus(outstanding.amount)) : dec(0);

  return (
    <div className="mx-auto w-full max-w-[52rem] space-y-6">
      <AutoPrint />

      <div className="flex items-center justify-between gap-3 print:hidden" data-print="hide">
        <p className="text-sm text-ink-muted">
          Use <span className="font-medium text-ink">Print</span> and choose “Save as PDF” to send this to the
          customer.
        </p>
        <PrintButton label="Print invoice" />
      </div>

      <article className="rounded-xl border border-line bg-surface p-8 shadow-card print:rounded-none print:border-0 print:p-0 print:shadow-none">
        {/* --- Masthead ------------------------------------------------- */}
        <header className="flex flex-wrap items-start justify-between gap-6 border-b-2 border-forest-800 pb-5">
          <div className="flex items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-forest-800 text-sm font-bold text-white">
              FID
            </span>
            <div>
              <p className="text-lg font-semibold tracking-tight text-ink">{company.legalName}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                {companyFlag(company.country)} {company.address}
                <br />
                {company.country}
              </p>
            </div>
          </div>

          <div className="text-right">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gold-700">Commercial Invoice</p>
            <p className="tnum mt-1 text-2xl font-semibold tracking-tight text-ink">{invoice.invoiceNumber}</p>
            {invoice.status !== 'POSTED' ? (
              <p className="mt-1 inline-block rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800">
                {invoice.status}
              </p>
            ) : null}
          </div>
        </header>

        {/* --- Parties and terms ---------------------------------------- */}
        <section className="grid gap-6 border-b border-line py-5 sm:grid-cols-2">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">Invoice to</p>
            <p className="mt-1.5 text-sm font-semibold text-ink">{invoice.customer.customerName}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
              {invoice.customer.address ? (
                <>
                  {invoice.customer.address}
                  <br />
                </>
              ) : null}
              {invoice.customer.country}
              {invoice.customer.contactPerson ? (
                <>
                  <br />
                  Attn: {invoice.customer.contactPerson}
                </>
              ) : null}
            </p>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:justify-self-end sm:text-right">
            <dt className="text-ink-subtle">Invoice date</dt>
            <dd className="tnum font-medium text-ink">{formatDate(invoice.invoiceDate)}</dd>

            <dt className="text-ink-subtle">Due date</dt>
            <dd className="tnum font-medium text-ink">
              {invoice.dueDate ? formatDate(invoice.dueDate) : '—'}
            </dd>

            <dt className="text-ink-subtle">Payment terms</dt>
            <dd className="font-medium text-ink">
              {invoice.paymentTermDays === 0 ? 'On delivery' : `${invoice.paymentTermDays} days`}
            </dd>

            <dt className="text-ink-subtle">Currency</dt>
            <dd className="font-medium text-ink">{invoice.currency}</dd>

            {invoice.reference ? (
              <>
                <dt className="text-ink-subtle">Your reference</dt>
                <dd className="font-medium text-ink">{invoice.reference}</dd>
              </>
            ) : null}

            {invoice.shipment ? (
              <>
                <dt className="text-ink-subtle">Shipment</dt>
                <dd className="font-medium text-ink">{invoice.shipment.shipmentNumber}</dd>
                {invoice.shipment.billOfLading ? (
                  <>
                    <dt className="text-ink-subtle">B/L</dt>
                    <dd className="font-medium text-ink">{invoice.shipment.billOfLading}</dd>
                  </>
                ) : null}
              </>
            ) : null}
          </dl>
        </section>

        {/* --- The coffee ------------------------------------------------ */}
        <section className="py-5">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-line-strong">
                <th className="pb-2 pr-3 font-semibold uppercase tracking-wider text-ink-subtle">Description</th>
                <th className="pb-2 px-3 text-right font-semibold uppercase tracking-wider text-ink-subtle">Bags</th>
                <th className="pb-2 px-3 text-right font-semibold uppercase tracking-wider text-ink-subtle">
                  Quantity
                </th>
                <th className="pb-2 px-3 text-right font-semibold uppercase tracking-wider text-ink-subtle">
                  Unit price
                </th>
                <th className="pb-2 pl-3 text-right font-semibold uppercase tracking-wider text-ink-subtle">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {invoice.lines.map((line) => (
                <tr key={line.id} className="align-top">
                  <td className="py-3 pr-3">
                    <p className="text-sm font-medium text-ink">{line.item.itemName}</p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
                      {[
                        line.item.originCountry,
                        line.item.grade,
                        line.item.screenSize ? `Screen ${line.item.screenSize}` : null,
                        line.item.cropYear ? `Crop ${line.item.cropYear}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    <p className="mt-0.5 text-[11px] text-ink-subtle">
                      {[
                        line.batch?.lot?.lotNumber ? `Lot ${line.batch.lot.lotNumber}` : null,
                        line.batch?.batchNumber ? `Batch ${line.batch.batchNumber}` : null,
                        line.container?.containerNumber ? `Container ${line.container.containerNumber}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </td>
                  <td className="tnum px-3 py-3 text-right text-ink">{line.bags.toLocaleString()}</td>
                  <td className="tnum px-3 py-3 text-right text-ink">{formatQuantityKg(line.quantityKg)}</td>
                  <td className="tnum px-3 py-3 text-right text-ink">
                    {formatMoney(line.unitPrice, invoice.currency)}
                    <span className="block text-[11px] text-ink-subtle">per KG</span>
                  </td>
                  <td className="tnum py-3 pl-3 text-right font-medium text-ink">
                    {formatMoney(line.lineTotal, invoice.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-line-strong">
                <td className="pt-3 pr-3 text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
                  Total
                </td>
                <td className="tnum px-3 pt-3 text-right font-medium text-ink">{totalBags.toLocaleString()}</td>
                <td className="tnum px-3 pt-3 text-right font-medium text-ink">{formatQuantityKg(totalKg)}</td>
                <td />
                <td className="tnum pt-3 pl-3 text-right text-base font-semibold text-ink">
                  {formatMoney(invoice.totalAmount, invoice.currency)}
                </td>
              </tr>
            </tfoot>
          </table>
        </section>

        {/* --- Settlement ------------------------------------------------ */}
        <section className="flex flex-wrap justify-end gap-6 border-t border-line pt-5">
          <dl className="min-w-56 space-y-1.5 text-sm">
            <div className="flex items-baseline justify-between gap-8">
              <dt className="text-ink-muted">Invoice total</dt>
              <dd className="tnum font-medium text-ink">{formatMoney(invoice.totalAmount, invoice.currency)}</dd>
            </div>
            {outstanding ? (
              <>
                <div className="flex items-baseline justify-between gap-8">
                  <dt className="text-ink-muted">Received</dt>
                  <dd className="tnum font-medium text-ink">{formatMoney(paid, invoice.currency)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-8 border-t border-line-strong pt-1.5">
                  <dt className="font-semibold text-ink">Balance due</dt>
                  <dd className="tnum text-base font-semibold text-ink">
                    {formatMoney(outstanding.amount, invoice.currency)}
                  </dd>
                </div>
              </>
            ) : null}
            {invoice.currency !== 'USD' ? (
              <p className="pt-1 text-[11px] text-ink-subtle">
                USD equivalent {formatMoney(invoice.totalAmountUsd, 'USD')} at {dec(invoice.rateToUsd).toFixed(4)}{' '}
                {invoice.currency}/USD
              </p>
            ) : null}
          </dl>
        </section>

        {invoice.notes ? (
          <section className="border-t border-line pt-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">Notes</p>
            <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink-muted">{invoice.notes}</p>
          </section>
        ) : null}

        <footer className="mt-6 border-t border-line pt-4 text-[11px] leading-relaxed text-ink-subtle">
          <p>
            Payment to be made to {company.legalName} in {invoice.currency}. Please quote{' '}
            <span className="font-medium text-ink-muted">{invoice.invoiceNumber}</span> with your remittance.
          </p>
          <p className="mt-1">
            Coffee is sold subject to the lot and batch references shown above, which identify the exact parcel
            supplied.
          </p>
        </footer>
      </article>
    </div>
  );
}
