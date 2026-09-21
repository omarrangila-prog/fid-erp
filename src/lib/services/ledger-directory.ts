import { prisma } from '@/lib/db';
import { Decimal, dec } from '@/lib/money';
import { getCustomerBalances, getVendorBalances, getTrialBalanceReport, getFinancialPosition } from '@/lib/services/reports';
import { getAgentNetBalances } from '@/lib/services/agent-account';

/**
 * The General Ledgers directory: every account that is not a customer or a
 * supplier — cash, banks, agents, loans, capital, income, expenses, and any
 * person or company with an account of their own — searchable by name.
 *
 * Customers and suppliers keep their own dedicated ledgers (Customer Ledger,
 * Supplier Ledger). They are still returned here, marked `elsewhere`, so a
 * search for "Bani" can say where Bani's ledger is rather than finding
 * nothing — but they are not mixed into the account list.
 *
 * Nothing here holds a balance of its own. Each entry points at the ledger
 * the application already keeps for it, and its balance is read from the
 * same place that ledger reads it, so the directory can never disagree with
 * the ledger it opens.
 */

export type LedgerKind = 'Customer' | 'Supplier' | 'Agent' | 'Bank' | 'Cash' | 'Loan' | 'Account';

export type LedgerEntry = {
  key: string;
  name: string;
  kind: LedgerKind;
  /** A second line: the account group, the country, the phone. */
  detail: string;
  currency: string;
  balance: Decimal;
  /** What the sign means for this ledger — "owes us", "we owe", "held". */
  balanceMeaning: string;
  href: string;
  /** Extra words the search matches on. */
  keywords: string;
  /** A second figure in USD, where the balance is in another currency. */
  usdEquivalent?: Decimal | null;
  /** Customers and suppliers: their ledger is the dedicated one, not this list. */
  elsewhere?: boolean;
};

const LOAN = /loan|financ|borrow|lend/i;

export async function getLedgerDirectory(companyId: string, localCurrency: string): Promise<LedgerEntry[]> {
  const [customers, vendors, agents, customerBalances, vendorBalances, agentBalances, trial, position] = await Promise.all([
    prisma.customer.findMany({ where: { companyId, status: 'ACTIVE' }, select: { id: true, customerName: true, primaryCurrency: true, country: true, phone: true, email: true } }),
    prisma.vendor.findMany({ where: { companyId, status: 'ACTIVE' }, select: { id: true, vendorName: true, primaryCurrency: true, country: true, phone: true, email: true } }),
    prisma.agent.findMany({ where: { companyId, status: 'ACTIVE' }, select: { id: true, agentName: true, phone: true } }),
    getCustomerBalances(companyId),
    getVendorBalances(companyId),
    getAgentNetBalances(companyId),
    getTrialBalanceReport({ companyId }),
    getFinancialPosition({ companyId }),
  ]);

  const entries: LedgerEntry[] = [];

  for (const c of customers) {
    const own = customerBalances.filter((b) => b.partyId === c.id);
    const balance = own.find((b) => b.currency === c.primaryCurrency)?.balance ?? own[0]?.balance ?? new Decimal(0);
    entries.push({
      key: `customer:${c.id}`,
      name: c.customerName,
      kind: 'Customer',
      detail: [c.country, c.phone].filter(Boolean).join(' · '),
      currency: own[0]?.currency ?? c.primaryCurrency,
      balance,
      balanceMeaning: balance.isNegative() ? 'we owe them' : 'owes us',
      href: `/ledgers/customers/${c.id}`,
      keywords: [c.phone, c.email].filter(Boolean).join(' '),
      elsewhere: true,
    });
  }

  for (const v of vendors) {
    const own = vendorBalances.filter((b) => b.partyId === v.id);
    const balance = own.find((b) => b.currency === v.primaryCurrency)?.balance ?? own[0]?.balance ?? new Decimal(0);
    entries.push({
      key: `supplier:${v.id}`,
      name: v.vendorName,
      kind: 'Supplier',
      detail: [v.country, v.phone].filter(Boolean).join(' · '),
      currency: own[0]?.currency ?? v.primaryCurrency,
      balance,
      balanceMeaning: balance.isNegative() ? 'owes us' : 'we owe',
      href: `/ledgers/vendors/${v.id}`,
      keywords: [v.phone, v.email].filter(Boolean).join(' '),
      elsewhere: true,
    });
  }

  // An agent's account: every posting tagged to them, in the company's own
  // currency, opening their complete ledger. One balance, from the same lines
  // the agent ledger reads — never a second account.
  for (const a of agents) {
    const net = agentBalances.get(a.id);
    const balance = net?.netLocal ?? new Decimal(0);
    entries.push({
      key: `agent:${a.id}`,
      name: a.agentName,
      kind: 'Agent',
      detail: ['Agent account', a.phone].filter(Boolean).join(' · '),
      currency: localCurrency,
      balance,
      balanceMeaning: balance.isNegative() ? 'we owe them' : 'owes us',
      href: `/agents/${a.id}`,
      keywords: `agent ${a.phone ?? ''}`,
      usdEquivalent: localCurrency === 'USD' ? null : (net?.netUsd ?? null),
    });
  }

  // Cash and bank, each in its own currency, opening the cash book for that drawer.
  const cashBankGl = new Set<string>();
  for (const account of position.accounts) {
    cashBankGl.add(account.glAccountId);
    const cash = account.accountType === 'CASH' || account.accountType === 'PETTY_CASH';
    entries.push({
      key: `cashbank:${account.accountId}`,
      name: account.name,
      kind: cash ? 'Cash' : 'Bank',
      detail: account.accountType === 'PETTY_CASH' ? 'Petty cash' : cash ? 'Cash in hand' : 'Bank account',
      currency: account.currency,
      balance: account.balance,
      balanceMeaning: 'held',
      href: `/reports/cash-book?account=${account.accountId}`,
      keywords: account.code,
    });
  }

  // Every other ledger account — loans, owners' current accounts, expenses —
  // opening the general ledger for that account.
  const accounts = await prisma.account.findMany({
    where: { companyId, status: 'ACTIVE' },
    select: { id: true, name: true, type: true, systemKey: true, currency: true, subledgerType: true },
  });
  // Closing balances in the company's own currency, with USD beside them.
  const closingLocal = new Map(trial.rows.map((r) => [r.accountId, dec(r.debitLocal).minus(dec(r.creditLocal))]));
  const closingUsd = new Map(trial.rows.map((r) => [r.accountId, dec(r.debitUsd).minus(dec(r.creditUsd))]));
  for (const account of accounts) {
    if (cashBankGl.has(account.id)) continue;
    const loan = LOAN.test(account.name) || (account.systemKey ?? '').includes('LOAN');
    const debitNatured = account.type === 'ASSET' || account.type === 'EXPENSE';
    const sign = (value: Decimal) => (debitNatured ? value : value.negated());
    const balance = sign(closingLocal.get(account.id) ?? new Decimal(0));
    const usd = sign(closingUsd.get(account.id) ?? new Decimal(0));
    const control =
      account.subledgerType === 'CUSTOMER'
        ? ' · control account — each customer is in Customer Ledger'
        : account.subledgerType === 'VENDOR'
          ? ' · control account — each supplier is in Supplier Ledger'
          : account.subledgerType === 'AGENT'
            ? ' · all agents'
            : '';
    entries.push({
      key: `account:${account.id}`,
      name: account.name,
      kind: loan ? 'Loan' : 'Account',
      detail: `${account.type.charAt(0)}${account.type.slice(1).toLowerCase()}${control}`,
      currency: localCurrency,
      balance,
      balanceMeaning: account.type === 'LIABILITY' ? (balance.isNegative() ? 'owed to us' : 'we owe') : account.type === 'ASSET' ? 'held / owed to us' : '',
      href: `/reports/general-ledger?account=${account.id}`,
      keywords: `${account.type} ${account.systemKey ?? ''}`,
      usdEquivalent: localCurrency === 'USD' ? null : usd,
    });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
