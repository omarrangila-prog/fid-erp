'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Loader2 } from 'lucide-react';
import { switchCompanyAction } from '@/server/actions/session-actions';
import { toast } from 'sonner';

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
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  function choose() {
    startTransition(async () => {
      const result = await switchCompanyAction(company.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.replace('/dashboard');
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={choose}
      disabled={pending}
      className="group flex flex-col gap-4 rounded-xl border border-navy-700 bg-navy-800 p-5 text-left transition-colors hover:border-teal-500 hover:bg-navy-800/70 disabled:opacity-60"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">{company.name}</p>
          <p className="mt-0.5 text-xs text-navy-400">
            {company.code} · Local currency {company.localCurrency}
          </p>
        </div>
        {pending ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-teal-300" />
        ) : (
          <ArrowRight className="size-4 shrink-0 text-navy-500 transition-colors group-hover:text-teal-300" />
        )}
      </div>

      <dl className="grid grid-cols-3 gap-2 border-t border-navy-700 pt-3">
        {[
          ['Shipments', company.shipments],
          ['Customers', company.customers],
          ['Invoices', company.openInvoices],
        ].map(([label, value]) => (
          <div key={label as string}>
            <dt className="text-[10px] uppercase tracking-wide text-navy-500">{label}</dt>
            <dd className="tnum text-sm font-semibold text-white">{value as number}</dd>
          </div>
        ))}
      </dl>
    </button>
  );
}
