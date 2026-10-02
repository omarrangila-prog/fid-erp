import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getCustomerLedger, ledgerKindToSourceType, resolvePartyLedgerQuery } from '@/lib/services/ledger';
import { formatMoney, formatDate, companyFlag, dayParam } from '@/lib/format';
import { PrintButton } from '@/components/shared/print-button';
import { ReportShareButton } from '@/components/share/report-share-button';
import { AutoPrint } from '@/app/(app)/sales/[id]/print/auto-print';
import { LedgerView } from '@/components/shared/ledger-view';

export const metadata: Metadata = { title: 'Customer statement' };
export const dynamic = 'force-dynamic';

function periodLabel(from?: Date, to?: Date) {
  if (from && to) return `${formatDate(from)} – ${formatDate(to)}`;
  if (from) return `From ${formatDate(from)}`;
  if (to) return `To ${formatDate(to)}`;
  return 'All dates';
}

export default async function CustomerLedgerPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string; from?: string; to?: string; kind?: string; currency?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const user = await requirePageAccess(PERMISSIONS.LEDGERS_VIEW);
  const companyId = user.activeCompany.id;

  const [customer, company] = await Promise.all([
    prisma.customer.findFirst({ where: { id, companyId } }),
    prisma.company.findUniqueOrThrow({ where: { id: companyId } }),
  ]);
  if (!customer) notFound();

  const resolved = resolvePartyLedgerQuery({
    view: query.view,
    currency: query.currency,
    localCurrency: user.activeCompany.localCurrency,
    partyCurrency: customer.primaryCurrency,
  });
  const from = dayParam(query.from) ?? undefined;
  const to = dayParam(query.to) ?? undefined;

  const ledger = await getCustomerLedger({
    companyId,
    customerId: id,
    view: resolved.view,
    currency: resolved.currency,
    localCurrency: user.activeCompany.localCurrency,
    partyCurrency: customer.primaryCurrency,
    from,
    to,
    sourceType: ledgerKindToSourceType(query.kind),
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
        <div className="flex flex-wrap gap-2">
          <PrintButton label="Print / Save as PDF" />
          <ReportShareButton report="customer-statement" subject={customer.customerName} />
        </div>
      </div>

      <article className="rounded-xl border border-line bg-surface p-4 shadow-card sm:p-8 print:rounded-none print:border-0 print:p-0 print:shadow-none">
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
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">Customer</p>
            <p className="mt-1.5 text-sm font-semibold text-ink">{customer.customerName}</p>
            <p className="mt-0.5 text-xs text-ink-muted">
              {customer.address ? (
                <>
                  <br />
                  {customer.address}
                </>
              ) : null}
              {customer.country ? (
                <>
                  <br />
                  {customer.country}
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

        <div className="mt-5">
          {/* The same ledger table as the screen, in the columns this person chose. */}
          <LedgerView
            ledger={ledger}
            basePath={`/ledgers/customers/${id}`}
            partyCurrency={customer.primaryCurrency}
            localCurrency={user.activeCompany.localCurrency}
            emptyDescription="Nothing in this period."
            report="customer"
            subject={customer.customerName}
            userId={user.id}
            companyName={companyName}
            mode="document"
          />
        </div>

        <p className="mt-6 text-[11px] text-ink-subtle">
          Outstanding balance is the amount still due. Debits are invoices; credits are receipts and credit notes.
        </p>
      </article>
    </div>
  );
}
