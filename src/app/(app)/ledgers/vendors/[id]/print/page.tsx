import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getVendorLedger, ledgerKindToSourceType, resolvePartyLedgerQuery } from '@/lib/services/ledger';
import { formatMoney, formatDate, companyFlag, titleCase } from '@/lib/format';
import { PrintButton } from '@/components/shared/print-button';
import { AutoPrint } from '@/app/(app)/sales/[id]/print/auto-print';

export const metadata: Metadata = { title: 'Supplier statement' };
export const dynamic = 'force-dynamic';

function periodLabel(from?: Date, to?: Date) {
  if (from && to) return `${formatDate(from)} – ${formatDate(to)}`;
  if (from) return `From ${formatDate(from)}`;
  if (to) return `To ${formatDate(to)}`;
  return 'All dates';
}

export default async function VendorLedgerPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string; from?: string; to?: string; kind?: string; currency?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const user = await requirePageAccess(PERMISSIONS.LEDGERS_VIEW);
  const companyId = user.activeCompany.id;

  const [vendor, company] = await Promise.all([
    prisma.vendor.findFirst({ where: { id, companyId } }),
    prisma.company.findUniqueOrThrow({ where: { id: companyId } }),
  ]);
  if (!vendor) notFound();

  const resolved = resolvePartyLedgerQuery({
    view: query.view,
    currency: query.currency,
    localCurrency: user.activeCompany.localCurrency,
    partyCurrency: vendor.primaryCurrency,
  });
  const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined;
  const to = query.to ? new Date(`${query.to}T00:00:00.000Z`) : undefined;

  const ledger = await getVendorLedger({
    companyId,
    vendorId: id,
    view: resolved.view,
    currency: resolved.currency,
    localCurrency: user.activeCompany.localCurrency,
    partyCurrency: vendor.primaryCurrency,
    from,
    to,
    sourceType: ledgerKindToSourceType(query.kind, 'vendor'),
  });

  const currency = ledger.viewCurrency;
  const companyName = company.legalName || company.name;

  return (
    <div className="mx-auto w-full max-w-[54rem] space-y-6">
      <AutoPrint />

      <div className="flex items-center justify-between gap-3 print:hidden" data-print="hide">
        <p className="text-sm text-ink-muted">
          Use <span className="font-medium text-ink">Print</span> and choose “Save as PDF” to send this statement.
        </p>
        <PrintButton label="Print / Save as PDF" />
      </div>

      <article className="rounded-xl border border-line bg-surface p-8 shadow-card print:rounded-none print:border-0 print:p-0 print:shadow-none">
        <header className="flex flex-wrap items-start justify-between gap-6 border-b-2 border-forest-800 pb-5">
          <div className="flex items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-forest-800 text-sm font-bold text-white">
              FID
            </span>
            <div>
              <p className="text-lg font-semibold tracking-tight text-ink">{companyName}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                {companyFlag(company.country)} {company.address}
                {company.address ? <br /> : null}
                {company.country}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gold-700">Account statement</p>
            <p className="mt-1 text-sm font-medium text-ink">{periodLabel(from, to)}</p>
            <p className="mt-0.5 text-xs text-ink-muted">Figures in {currency}</p>
          </div>
        </header>

        <section className="grid gap-6 border-b border-line py-5 sm:grid-cols-2">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">Supplier</p>
            <p className="mt-1.5 text-sm font-semibold text-ink">{vendor.vendorName}</p>
            <p className="mt-0.5 text-xs text-ink-muted">
              {vendor.country ? (
                <>
                  <br />
                  {vendor.country}
                </>
              ) : null}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:justify-self-end sm:text-right">
            <dt className="text-ink-subtle">Opening balance</dt>
            <dd className="tnum font-medium text-ink">{formatMoney(ledger.openingBalance, currency)}</dd>
            <dt className="text-ink-subtle">Closing balance</dt>
            <dd className="tnum font-semibold text-ink">{formatMoney(ledger.closingBalance, currency)}</dd>
          </dl>
        </section>

        <table className="mt-5 w-full border-collapse text-xs">
          <thead>
            <tr className="bg-forest-800 text-white">
              <th className="border border-forest-800 px-2 py-2 text-left font-semibold">Date</th>
              <th className="border border-forest-800 px-2 py-2 text-left font-semibold">Reference</th>
              <th className="border border-forest-800 px-2 py-2 text-left font-semibold">Description</th>
              <th className="border border-forest-800 px-2 py-2 text-right font-semibold">Debit</th>
              <th className="border border-forest-800 px-2 py-2 text-right font-semibold">Credit</th>
              <th className="border border-forest-800 px-2 py-2 text-right font-semibold">Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr className="bg-forest-50">
              <td className="border border-line px-2 py-1.5" colSpan={5}>
                Opening balance
              </td>
              <td className="tnum border border-line px-2 py-1.5 text-right font-semibold">
                {formatMoney(ledger.openingBalance, currency)}
              </td>
            </tr>
            {ledger.rows.map((row, index) => {
              const debit = row.debit;
              const credit = row.credit;
              const amountCurrency = row.currency;
              return (
                <tr key={`${row.journalEntryId}-${index}`}>
                  <td className="border border-line px-2 py-1.5 whitespace-nowrap">{formatDate(row.entryDate)}</td>
                  <td className="border border-line px-2 py-1.5 font-medium">{row.reference ?? row.entryNumber}</td>
                  <td className="border border-line px-2 py-1.5">
                    {row.description}
                    <span className="block text-[10px] text-ink-subtle">{titleCase(row.sourceType)}</span>
                  </td>
                  <td className="tnum border border-line px-2 py-1.5 text-right">
                    {debit.greaterThan(0) ? formatMoney(debit, amountCurrency) : '—'}
                  </td>
                  <td className="tnum border border-line px-2 py-1.5 text-right">
                    {credit.greaterThan(0) ? formatMoney(credit, amountCurrency) : '—'}
                  </td>
                  <td className="tnum border border-line px-2 py-1.5 text-right font-medium">
                    {formatMoney(row.balance, currency)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-forest-50 font-semibold">
              <td className="border border-line px-2 py-2" colSpan={3}>
                Totals / closing
              </td>
              <td className="tnum border border-line px-2 py-2 text-right">
                {formatMoney(ledger.totalDebit, currency)}
              </td>
              <td className="tnum border border-line px-2 py-2 text-right">
                {formatMoney(ledger.totalCredit, currency)}
              </td>
              <td className="tnum border border-line px-2 py-2 text-right">
                {formatMoney(ledger.closingBalance, currency)}
              </td>
            </tr>
          </tfoot>
        </table>

        <p className="mt-6 text-[11px] text-ink-subtle">
          Outstanding balance is the amount still owed to the supplier. Credits are purchases; debits are payments.
        </p>
      </article>
    </div>
  );
}
