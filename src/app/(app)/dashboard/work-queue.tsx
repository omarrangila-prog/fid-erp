import Link from 'next/link';
import {
  FileText, PackageCheck, ClipboardList, ShoppingCart, Receipt,
  ArrowLeftRight, ArrowDownToLine, ArrowRight, ClipboardCheck,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PERMISSIONS, type PermissionCode } from '@/lib/constants';
import { cn } from '@/lib/utils';

export type RecentEntry = {
  id: string;
  href: string;
  reference: string;
  description: string;
  when: string;
  status: string;
};

type Task = {
  label: string;
  hint: string;
  href: string;
  icon: typeof FileText;
  permission: PermissionCode;
  accent?: boolean;
};

/**
 * The home screen for somebody whose job is entering documents.
 *
 * A management dashboard is the wrong first screen for them: cash position,
 * margin and profit are not their business, and eleven charts they cannot act
 * on make the useful thing — starting the next document — harder to find.
 *
 * So this is a work queue. Big targets for the handful of things they do all
 * day, then what they entered most recently, so they can check their own work
 * or carry on where they stopped. Nothing else.
 */
const TASKS: Task[] = [
  { label: 'New purchase', hint: 'A contract you have agreed to buy', href: '/purchases/new', icon: FileText, permission: PERMISSIONS.PURCHASES_CREATE, accent: true },
  { label: 'Goods receipt', hint: 'Book arriving coffee into a warehouse', href: '/goods-receipts', icon: PackageCheck, permission: PERMISSIONS.INVENTORY_VIEW },
  { label: 'Loading sheet', hint: 'Update status, B/L, ETA and documents', href: '/loading', icon: ClipboardList, permission: PERMISSIONS.SHIPMENTS_VIEW },
  { label: 'New sale', hint: 'Invoice a customer from stock', href: '/sales/new', icon: ShoppingCart, permission: PERMISSIONS.SALES_CREATE, accent: true },
  { label: 'Record a receipt', hint: 'Money received from a customer', href: '/finance/receipts/new', icon: ArrowDownToLine, permission: PERMISSIONS.RECEIPTS_CREATE },
  { label: 'Record an expense', hint: 'Freight, clearing, bank charges', href: '/finance/expenses/new', icon: Receipt, permission: PERMISSIONS.EXPENSES_CREATE },
  { label: 'Warehouse transfer', hint: 'Move stock between warehouses', href: '/inventory/transfers/new', icon: ArrowLeftRight, permission: PERMISSIONS.INVENTORY_TRANSFER },
  { label: 'Stock count', hint: 'Check a warehouse against the books', href: '/inventory/stock-counts/new', icon: ClipboardCheck, permission: PERMISSIONS.STOCK_COUNT_MANAGE },
];

export function WorkQueue({
  firstName,
  greeting,
  companyName,
  permissions,
  recent,
}: {
  firstName: string;
  greeting: string;
  companyName: string;
  permissions: Set<string>;
  recent: RecentEntry[];
}) {
  const tasks = TASKS.filter((task) => permissions.has(task.permission));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          {greeting}, {firstName}
        </h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          You are working in {companyName}. Pick what you are entering.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tasks.map((task) => {
          const Icon = task.icon;
          return (
            <Link
              key={task.href}
              href={task.href}
              className={cn(
                'group flex min-h-24 flex-col justify-between rounded-xl border bg-surface p-4 shadow-card transition-colors',
                task.accent
                  ? 'border-forest-200 hover:border-forest-400 hover:bg-forest-50/60'
                  : 'border-line hover:border-forest-300 hover:bg-forest-50/40',
              )}
            >
              <span
                className={cn(
                  'grid size-9 place-items-center rounded-lg',
                  task.accent ? 'bg-forest-800 text-white' : 'bg-forest-50 text-forest-700',
                )}
              >
                <Icon className="size-4.5" />
              </span>
              <span className="mt-3 block">
                <span className="flex items-center gap-1 text-sm font-semibold text-ink">
                  {task.label}
                  <ArrowRight className="size-3.5 -translate-x-1 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                </span>
                <span className="mt-0.5 block text-xs text-ink-muted">{task.hint}</span>
              </span>
            </Link>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>What you entered recently</CardTitle>
          <CardDescription>Your last twelve documents, newest first.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 sm:px-0">
          {recent.length === 0 ? (
            <p className="px-5 pb-4 text-sm text-ink-subtle">
              Nothing yet. Whatever you enter appears here so you can check it.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {recent.map((entry) => (
                <li key={entry.id}>
                  <Link
                    href={entry.href}
                    className="flex items-center justify-between gap-3 px-5 py-2.5 transition-colors hover:bg-forest-50/50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">{entry.reference}</span>
                      <span className="block truncate text-xs text-ink-subtle">{entry.description}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="hidden text-xs text-ink-subtle sm:inline">{entry.when}</span>
                      <Badge tone={entry.status === 'POSTED' ? 'success' : 'neutral'}>
                        {entry.status.toLowerCase()}
                      </Badge>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
