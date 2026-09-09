import type { Metadata } from 'next';
import Link from 'next/link';
import {
  FileText, PackageCheck, Boxes, ShoppingCart, ArrowDownToLine, BookOpen,
  ArrowRight, Warehouse, Coins, ShieldCheck,
} from 'lucide-react';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getSetupStatus, toChecklistStep } from '@/lib/services/setup';
import { PageHeader } from '@/components/shared/page-header';
import { SetupChecklist } from '@/components/shared/setup-checklist';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Getting started' };
export const dynamic = 'force-dynamic';

/** The trade, in the order it actually happens. */
const FLOW = [
  {
    icon: FileText,
    title: 'Purchase contract',
    body: 'What you agreed to buy. Books the supplier payable and the coffee in transit. No stock yet.',
    href: '/purchases',
  },
  {
    icon: PackageCheck,
    title: 'Goods receipt',
    body: 'The coffee arrives. Choose the warehouse and the quantity actually received — this is the step that adds stock.',
    href: '/goods-receipts',
  },
  {
    icon: Boxes,
    title: 'Stock',
    body: 'Held per warehouse, per batch, in both kilograms and bags. Transfers move it; they never create it.',
    href: '/inventory',
  },
  {
    icon: ShoppingCart,
    title: 'Sales invoice',
    body: 'Stock leaves the warehouse, the customer is invoiced, and the cost of what you sold is taken from the batch.',
    href: '/sales',
  },
  {
    icon: ArrowDownToLine,
    title: 'Receipt',
    body: 'Money in — cash, bank or cheque — allocated to the invoices it settles.',
    href: '/finance/receipts',
  },
  {
    icon: BookOpen,
    title: 'Books and reports',
    body: 'Every step above wrote its own double-entry journal as it happened. Nothing to post at month end.',
    href: '/reports',
  },
];

const RULES = [
  {
    icon: Warehouse,
    title: 'A purchase order is not a goods receipt',
    body: 'Ordering coffee never increases stock. Only a goods receipt does, and it always names a warehouse. Order 60,000 KG, receive 19,200, and stock shows 19,200 with 40,800 still on the water.',
  },
  {
    icon: Boxes,
    title: 'A transfer moves stock, it never copies it',
    body: 'Move 20 KG out of a 100 KG warehouse and you have 80 there and 20 at the other. The company total is still 100.',
  },
  {
    icon: Coins,
    title: 'Currencies are never added together',
    body: 'AED, MAD and USD balances are shown separately. Group reporting converts at the rate on the voucher date, and an old voucher is never restated when the rate moves.',
  },
  {
    icon: ShieldCheck,
    title: 'Your company is your company',
    body: 'Dubai staff see Dubai. Morocco staff see Morocco. A record from the other company is not hidden — it does not exist for you.',
  },
];

export default async function GettingStartedPage() {
  const user = await requirePageAccess(PERMISSIONS.DASHBOARD_VIEW);
  const status = await getSetupStatus(user.activeCompany.id);

  const steps = status.steps
    .filter((step) => can(user, step.permission))
    .map(toChecklistStep);
  const completed = steps.filter((step) => step.done).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Getting started"
        description={`How ${user.activeCompany.name} runs on FID, and what is still to be set up.`}
        breadcrumbs={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Getting started' }]}
      />

      {steps.length > 0 ? <SetupChecklist steps={steps} completed={completed} total={steps.length} /> : null}

      <Card>
        <CardHeader>
          <CardTitle>Enter once, update everywhere</CardTitle>
          <CardDescription>
            You record the trade as it happens. Stock, ledgers, profit and the financial statements follow on their
            own — there is no second set of books to keep.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FLOW.map((stage, index) => {
              const Icon = stage.icon;
              return (
                <li key={stage.title}>
                  <Link
                    href={stage.href}
                    className="group flex h-full flex-col rounded-xl border border-line bg-paper p-4 transition-colors hover:border-teal-300 hover:bg-teal-50/40"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-navy-800 text-white">
                        <Icon className="size-4" />
                      </span>
                      <span className="tnum text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
                        Step {index + 1}
                      </span>
                    </div>
                    <p className="mt-3 text-sm font-semibold text-ink">{stage.title}</p>
                    <p className="mt-1 flex-1 text-xs leading-relaxed text-ink-muted">{stage.body}</p>
                    <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-teal-700 opacity-0 transition-opacity group-hover:opacity-100">
                      Open <ArrowRight className="size-3.5" />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Four rules worth knowing</CardTitle>
          <CardDescription>These are enforced by the system, not left to memory.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-5 sm:grid-cols-2">
            {RULES.map((rule) => {
              const Icon = rule.icon;
              return (
                <div key={rule.title} className="flex gap-3">
                  <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-teal-50 text-teal-700">
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <dt className="text-sm font-semibold text-ink">{rule.title}</dt>
                    <dd className="mt-1 text-xs leading-relaxed text-ink-muted">{rule.body}</dd>
                  </div>
                </div>
              );
            })}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
