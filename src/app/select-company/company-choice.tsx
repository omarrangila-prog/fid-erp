'use client';

import * as React from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { chooseCompanyFormAction } from '@/server/actions/session-actions';

/**
 * One company to choose. A form, not a click handler: it submits as soon as
 * the screen is there, before the page's scripts have finished loading, and
 * the server takes the user to the dashboard. An early tap is never lost.
 */
export function CompanyChoice({
  company,
}: {
  company: {
    id: string;
    code: string;
    name: string;
    localCurrency: string;
    shipments: number;
    customers: number;
    openInvoices: number;
  };
}) {
  const [state, formAction, pending] = React.useActionState(chooseCompanyFormAction, null);

  return (
    <form action={formAction} className="contents">
    <input type="hidden" name="companyId" value={company.id} />
    <button
      type="submit"
      disabled={pending}
      className="group flex flex-col gap-4 rounded-xl border border-line bg-surface p-5 text-left transition-colors hover:border-gold-500 hover:bg-surface/70 disabled:opacity-60"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{company.name}</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            {company.code} · Local currency {company.localCurrency}
          </p>
        </div>
        {pending ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-gold-300" />
        ) : (
          <ArrowRight className="size-4 shrink-0 text-ink-muted transition-colors group-hover:text-gold-300" />
        )}
      </div>

      <dl className="grid grid-cols-1 gap-2 border-t border-line pt-3 min-[380px]:grid-cols-3">
        {[
          ['Shipments', company.shipments],
          ['Customers', company.customers],
          ['Invoices', company.openInvoices],
        ].map(([label, value]) => (
          <div key={label as string}>
            <dt className="text-[11px] uppercase tracking-wide text-ink-muted">{label}</dt>
            <dd className="tnum text-sm font-semibold text-ink">{value as number}</dd>
          </div>
        ))}
      </dl>
    </button>
    {state?.error ? (
      <p role="alert" className="text-xs text-red-700">
        {state.error}
      </p>
    ) : null}
    </form>
  );
}
