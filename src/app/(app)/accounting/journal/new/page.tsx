import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getRateDefaults } from '@/lib/services/exchange-rate';
import { prisma } from '@/lib/db';
import { toDateInputValue } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { JournalForm, type AccountOption } from '@/app/(app)/accounting/journal/new/journal-form';

export const metadata: Metadata = { title: 'New Journal Voucher' };
export const dynamic = 'force-dynamic';

export default async function NewJournalEntryPage() {
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_POST);

  const [accounts, customerRows] = await Promise.all([
    prisma.account.findMany({
      where: { companyId: user.activeCompany.id, status: 'ACTIVE' },
      orderBy: { code: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        // A cash or bank drawer holds one currency and one only, so a voucher
        // in another currency cannot be recorded through it. The form needs to
        // know that while the account is being chosen, not after Post.
        cashBankAccounts: { where: { status: 'ACTIVE' }, select: { currency: true } },
      },
    }),
    prisma.customer.findMany({
      where: { companyId: user.activeCompany.id, status: 'ACTIVE' },
      orderBy: { customerName: 'asc' },
      select: { id: true, customerName: true, customerCode: true, primaryCurrency: true },
    }),
  ]);

  const options: AccountOption[] = accounts.map((account) => ({
    value: account.id,
    label: `${account.code} — ${account.name}`,
    hint: account.type.replaceAll('_', ' ').toLowerCase(),
    keywords: `${account.code} ${account.name} ${account.type}`,
    accountType: account.type,
    drawerCurrencies: [...new Set(account.cashBankAccounts.map((d) => d.currency))],
  }));

  const rates = await getRateDefaults(user.activeCompany.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Journal Voucher"
        description="A direct double-entry posting for corrections, accruals and opening balances."
        breadcrumbs={[
          { label: 'Accounting' },
          { label: 'Journal', href: '/reports/journal' },
          { label: 'New voucher' },
        ]}
      />
      <JournalForm
        accounts={options}
        customers={customerRows.map((c) => ({
          value: c.id,
          label: c.customerName,
          hint: `${c.customerCode} · ${c.primaryCurrency}`,
          keywords: c.customerCode,
        }))}
        localCurrency={user.activeCompany.localCurrency}
        defaultLocalRate={rates.local}
        ratesByCurrency={rates.byCurrency}
        today={toDateInputValue(new Date())}
      />
    </div>
  );
}
