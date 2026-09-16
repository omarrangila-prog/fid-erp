'use client';

import { BookOpen, ArrowLeftRight, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import { RowActions, viewAction } from '@/components/shared/row-actions';
import { ledgerHref } from '@/lib/ledger-currency';

/**
 * What can be done to a cash or bank account from the list.
 *
 * The cash book and the ledger account are two views of the same postings,
 * so both are one click away; a receipt and a payment are the two things
 * that usually follow from looking at a balance.
 */
export function CashAccountRowActions({
  accountId,
  glAccountId,
  currency,
}: {
  accountId: string;
  glAccountId: string;
  currency: string;
}) {
  return (
    <RowActions
      actions={[
        viewAction(`/finance/cash-bank/${accountId}`),
        { label: 'Ledger', href: ledgerHref(glAccountId, currency), icon: BookOpen },
        { label: 'Receive money', href: `/finance/receipts/new?account=${accountId}`, icon: ArrowDownToLine },
        { label: 'Pay out', href: `/finance/payments/new?account=${accountId}`, icon: ArrowUpFromLine },
        { label: 'Transfer', href: '/finance/cash-bank', icon: ArrowLeftRight, overflowOnly: true },
      ]}
    />
  );
}
