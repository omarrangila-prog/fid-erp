'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  HandCoins,
  Landmark,
  PiggyBank,
  Scale,
  SlidersHorizontal,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

/**
 * What are you doing? — asked before any accounting.
 *
 * Most of what reaches the general journal is not really a journal: it is
 * money arriving, money leaving, money moving, or a loan. Each of those has a
 * screen that knows the right accounts and posts the double entry itself, and
 * being made to think in debits and credits to record them is a tax on
 * somebody who runs a coffee business rather than a ledger.
 *
 * So this asks the business question first and sends each answer to the screen
 * that already handles it properly. The accounting underneath is unchanged —
 * every one of these posts a balanced double entry — but nobody has to choose
 * a side to get there. The journal proper is still one click away for an
 * accountant who wants it.
 */

type Choice = {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  blurb: string;
  /** What the books do, for somebody who wants to know. */
  posts: string;
};

const CHOICES: Choice[] = [
  {
    href: '/finance/intercompany-loan',
    icon: Landmark,
    title: 'Loan received or given',
    blurb: 'Money lent between your companies — Dubai to Morocco, or back again.',
    posts: 'The bank goes up and a loan balance is recorded. Neither side is income or expense.',
  },
  {
    href: '/finance/receipts/new',
    icon: ArrowDownToLine,
    title: 'Money received',
    blurb: 'A customer has paid you. Choose who, the account it landed in, and how much.',
    posts: 'The account rises and what the customer owes falls.',
  },
  {
    href: '/finance/payments/new',
    icon: ArrowUpFromLine,
    title: 'Money paid',
    blurb: 'You have paid a supplier, or settled a cost booked earlier.',
    posts: 'The account falls and what you owe falls with it.',
  },
  {
    href: '/finance/cash-bank',
    icon: ArrowLeftRight,
    title: 'Transfer between accounts',
    blurb: 'Your own money moving between your own accounts, converting if the currencies differ.',
    posts: 'One account down, the other up. Nothing is earned or spent.',
  },
  {
    href: '/finance/expenses/new',
    icon: HandCoins,
    title: 'A cost',
    blurb: 'Something the business paid for, or owes for — freight, rent, clearing, commission.',
    posts: 'The cost is recorded, and either cash falls or a payable is raised.',
  },
  {
    href: '/accounting/chart',
    icon: PiggyBank,
    title: 'Opening balances',
    blurb: 'What an account was already carrying on the day the books started here.',
    posts: 'Posted against Opening Balance Equity, so the trial balance still balances.',
  },
];

export function GuidedChooser({ onAdvanced }: { onAdvanced: () => void }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>What are you doing?</CardTitle>
          <CardDescription>
            Choose the thing that happened. The accounting is written for you — correctly, and in full.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {CHOICES.map((choice) => {
            const Icon = choice.icon;
            return (
              <Link
                key={choice.href + choice.title}
                href={choice.href}
                className="flex gap-3 rounded-xl border-2 border-line bg-surface p-4 transition-colors hover:border-forest-300 hover:bg-forest-50/40"
              >
                <Icon className="mt-0.5 size-5 shrink-0 text-forest-700" />
                <span>
                  <span className="block text-sm font-semibold text-ink">{choice.title}</span>
                  <span className="mt-0.5 block text-xs text-ink-muted">{choice.blurb}</span>
                  <span className="mt-1.5 block text-[11px] text-ink-subtle">{choice.posts}</span>
                </span>
              </Link>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-3">
            <SlidersHorizontal className="mt-0.5 size-5 shrink-0 text-ink-subtle" />
            <div>
              <p className="text-sm font-semibold text-ink">None of these — write the entry myself</p>
              <p className="mt-0.5 text-xs text-ink-muted">
                Debits and credits, as many lines as you like, each in its own currency. For corrections and
                accruals that have no screen of their own.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onAdvanced}
            className="shrink-0 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-forest-300 hover:bg-forest-50"
          >
            <span className="flex items-center gap-1.5">
              <Scale className="size-4" />
              Advanced journal entry
            </span>
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
