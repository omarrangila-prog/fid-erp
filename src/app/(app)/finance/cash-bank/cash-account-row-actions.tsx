'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { BookOpen, ArrowLeftRight, ArrowDownToLine, ArrowUpFromLine, EyeOff } from 'lucide-react';
import { RowActions, viewAction } from '@/components/shared/row-actions';
import { ledgerHref } from '@/lib/ledger-currency';
import { deleteCashBankAccountAction, toggleMasterStatusAction } from '@/server/actions/master-actions';

/**
 * What can be done to a cash or bank account from the list.
 *
 * The cash book and the ledger account are two views of the same postings, so
 * both are one click away; a receipt and a payment are the two things that
 * usually follow from looking at a balance.
 *
 * Two ways to get rid of one, because they mean different things. An account
 * money has moved through cannot be deleted — the cash book and the ledger are
 * made of those postings — so it is made inactive, which takes it out of every
 * picker while the history stays readable. An account opened by mistake has no
 * history to keep, and that one really is deleted, along with the ledger
 * account that opening it created.
 */
export function CashAccountRowActions({
  accountId,
  glAccountId,
  currency,
  name,
  canManage,
}: {
  accountId: string;
  glAccountId: string;
  currency: string;
  name: string;
  canManage: boolean;
}) {
  const router = useRouter();

  return (
    <RowActions
      actions={[
        viewAction(`/finance/cash-bank/${accountId}`),
        { label: 'Ledger', href: ledgerHref(glAccountId, currency), icon: BookOpen },
        { label: 'Receive money', href: `/finance/receipts/new?account=${accountId}`, icon: ArrowDownToLine },
        { label: 'Pay out', href: `/finance/payments/new?account=${accountId}`, icon: ArrowUpFromLine },
        { label: 'Transfer', href: '/finance/cash-bank', icon: ArrowLeftRight, overflowOnly: true },
        {
          label: 'Make inactive',
          icon: EyeOff,
          show: canManage,
          overflowOnly: true,
          onSelect: async () => {
            const result = await toggleMasterStatusAction('cashBankAccount', accountId, 'INACTIVE');
            if (!result.ok) {
              toast.error(result.error);
              return;
            }
            toast.success(`${name} is now inactive.`);
            router.refresh();
          },
        },
      ]}
      destructive={{
        status: 'ACTIVE',
        noun: 'account',
        show: canManage,
        cancelLabel: 'Delete',
        description:
          'An account nothing has ever moved through is removed completely, along with the ledger account that opening it created. If money has gone through it, it cannot be deleted — use Make inactive instead, which hides it everywhere while the history stays readable.',
        run: async () => {
          const result = await deleteCashBankAccountAction(accountId);
          return { ok: result.ok, error: result.ok ? undefined : result.error };
        },
      }}
    />
  );
}
