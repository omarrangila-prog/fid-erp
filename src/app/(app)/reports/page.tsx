import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Wallet, TrendingUp, Scale, ListChecks, ArrowLeftRight, BookOpen, Receipt,
  Boxes, Layers, Truck, History, CircleDollarSign, HandCoins, Ship, LineChart,
} from 'lucide-react';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, type PermissionCode } from '@/lib/constants';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Reports' };
export const dynamic = 'force-dynamic';

type ReportLink = {
  href: string;
  title: string;
  description: string;
  icon: typeof Wallet;
  permission: PermissionCode;
};

const GROUPS: Array<{ title: string; description: string; reports: ReportLink[] }> = [
  {
    title: 'Position',
    description: 'What the company has, right now.',
    reports: [
      {
        href: '/reports/financial-position',
        title: 'Financial Position',
        description: 'Cash and bank by currency, receivables, payables, stock value — the whole picture on one page.',
        icon: Wallet,
        permission: PERMISSIONS.CASHBANK_VIEW,
      },
      {
        href: '/reports/balance-sheet',
        title: 'Balance Sheet',
        description: 'Assets, liabilities and equity as at a date, from the double-entry records.',
        icon: Scale,
        permission: PERMISSIONS.ACCOUNTING_VIEW,
      },
      {
        href: '/reports/trial-balance',
        title: 'Trial Balance',
        description: 'Every account with a balance, in USD and local currency.',
        icon: ListChecks,
        permission: PERMISSIONS.ACCOUNTING_VIEW,
      },
    ],
  },
  {
    title: 'Performance',
    description: 'How the business is doing.',
    reports: [
      {
        href: '/reports/profit-loss',
        title: 'Profit & Loss',
        description: 'Revenue less cost of goods sold and operating expenses, for any period.',
        icon: TrendingUp,
        permission: PERMISSIONS.ACCOUNTING_VIEW,
      },
      {
        href: '/profitability',
        title: 'Shipment Profitability',
        description: 'Margin per job, per customer, per coffee, per batch and per container.',
        icon: Ship,
        permission: PERMISSIONS.PROFITS_VIEW,
      },
      {
        href: '/reports/cash-flow',
        title: 'Cash Flow',
        description: 'Money in and out of every cash and bank account, grouped by what caused it.',
        icon: ArrowLeftRight,
        permission: PERMISSIONS.CASHBANK_VIEW,
      },
      {
        href: '/reports/expenses',
        title: 'Expense Report',
        description: 'Costs by category, by job or by month.',
        icon: Receipt,
        permission: PERMISSIONS.EXPENSES_VIEW,
      },
    ],
  },
  {
    title: 'Accounting',
    description: 'The underlying records.',
    reports: [
      {
        href: '/reports/general-ledger',
        title: 'General Ledger',
        description: 'Every movement through a chosen account, with a running balance.',
        icon: BookOpen,
        permission: PERMISSIONS.ACCOUNTING_VIEW,
      },
      {
        href: '/reports/journal',
        title: 'Journal',
        description: 'Every posted entry with its lines, newest first.',
        icon: LineChart,
        permission: PERMISSIONS.ACCOUNTING_VIEW,
      },
      {
        href: '/ledgers/customers',
        title: 'Customer Ledgers',
        description: 'Per-customer account in their currency, USD or local books.',
        icon: CircleDollarSign,
        permission: PERMISSIONS.LEDGERS_VIEW,
      },
      {
        href: '/ledgers/vendors',
        title: 'Supplier Ledgers',
        description: 'Per-supplier account with the same three views.',
        icon: HandCoins,
        permission: PERMISSIONS.LEDGERS_VIEW,
      },
    ],
  },
  {
    title: 'Inventory',
    description: 'Where the coffee is and what it is worth.',
    reports: [
      {
        href: '/inventory',
        title: 'Current Stock',
        description: 'Company totals with the warehouse split behind them.',
        icon: Boxes,
        permission: PERMISSIONS.INVENTORY_VIEW,
      },
      {
        href: '/inventory/batches',
        title: 'Batch & Lot Stock',
        description: 'Full traceability: batch, lot, container, warehouse and what is left.',
        icon: Layers,
        permission: PERMISSIONS.INVENTORY_VIEW,
      },
      {
        href: '/inventory/shipments',
        title: 'Shipment Stock',
        description: 'What each job brought in, sold and still holds.',
        icon: Truck,
        permission: PERMISSIONS.INVENTORY_VIEW,
      },
      {
        href: '/inventory/movements',
        title: 'Stock Movements',
        description: 'The append-only ledger behind every stock figure.',
        icon: History,
        permission: PERMISSIONS.INVENTORY_VIEW,
      },
    ],
  },
  {
    title: 'Receivables and payables',
    description: 'Who owes what, and for how long.',
    reports: [
      {
        href: '/finance/receivables',
        title: 'Customer Outstanding',
        description: 'Open invoices with ageing buckets.',
        icon: CircleDollarSign,
        permission: PERMISSIONS.RECEIVABLES_VIEW,
      },
      {
        href: '/finance/payables',
        title: 'Supplier Payables',
        description: 'Open contracts with ageing buckets.',
        icon: HandCoins,
        permission: PERMISSIONS.PAYABLES_VIEW,
      },
      {
        href: '/loading',
        title: 'Loading Follow-Up',
        description: 'Batch-level shipment sheet with booking, B/L, ETA and sold status.',
        icon: Ship,
        permission: PERMISSIONS.SHIPMENTS_VIEW,
      },
    ],
  },
];

export default async function ReportsPage() {
  const user = await requirePageAccess(PERMISSIONS.REPORTS_VIEW);

  const groups = GROUPS.map((group) => ({
    ...group,
    reports: group.reports.filter((report) => can(user, report.permission)),
  })).filter((group) => group.reports.length > 0);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Reports"
        description="Every figure is calculated from posted transactions. Nothing here is a stored summary."
        breadcrumbs={[{ label: 'Reports' }]}
      />

      {groups.map((group) => (
        <section key={group.title} className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">{group.title}</h2>
            <p className="text-xs text-ink-muted">{group.description}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {group.reports.map((report) => (
              <Link key={report.href} href={report.href}>
                <Card className="h-full p-4 transition-colors hover:border-navy-300 hover:bg-navy-50/40">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-navy-50">
                      <report.icon className="size-4 text-navy-600" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-ink">{report.title}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                        {report.description}
                      </span>
                    </span>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export { CardContent };
