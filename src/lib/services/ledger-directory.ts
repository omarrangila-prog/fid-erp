import { prisma } from '@/lib/db';
import { Decimal, dec } from '@/lib/money';
import { getCustomerBalances, getVendorBalances, getTrialBalanceReport, getFinancialPosition } from '@/lib/services/reports';
import { getAgentNetBalances, getAgentSummaries } from '@/lib/services/agent-account';
import { formatMoney } from '@/lib/format';

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
  /**
   * The accounts that belong to this one party, folded underneath it.
   *
   * One man who collects money, lends money and buys coffee has four or five
   * ledger accounts. Listing them side by side reads as four or five
   * different people, which is what the client was looking at. He is one row;
   * these open underneath it.
   */
  children?: LedgerEntry[];
  /** Plain sentences for a party row: what he owes, what he is owed. */
  summary?: Array<{ label: string; value: string }>;
  /** True for a row that only exists in the accountant's view of the list. */
  advancedOnly?: boolean;
};

const LOAN = /loan|financ|borrow|lend/i;

export async function getLedgerDirectory(companyId: string, localCurrency: string): Promise<LedgerEntry[]> {
  const [customers, vendors, agents, customerBalances, vendorBalances, agentBalances, summaries, trial, position] = await Promise.all([
    prisma.customer.findMany({ where: { companyId, status: 'ACTIVE' }, select: { id: true, customerName: true, primaryCurrency: true, country: true, phone: true, email: true } }),
    prisma.vendor.findMany({ where: { companyId, status: 'ACTIVE' }, select: { id: true, vendorName: true, primaryCurrency: true, country: true, phone: true, email: true } }),
    prisma.agent.findMany({ where: { companyId, status: 'ACTIVE' }, select: { id: true, agentName: true, phone: true } }),
    getCustomerBalances(companyId),
    getVendorBalances(companyId),
    getAgentNetBalances(companyId),
    getAgentSummaries(companyId),
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

  /*
   * One party, one row.
   *
   * A man who collects the company's money, lends it money and buys coffee
   * from it has an Agent Clearing balance, a loan account, a trade
   * receivable and perhaps a commission. Those are four accounts because
   * they are four different things on the balance sheet — and one person.
   * He appears here once, with what he owes and what he is owed said in
   * words, and his accounts fold underneath.
   */
  const money = (value: Decimal) => formatMoney(value.abs(), localCurrency);
  const partySummaries = new Map(summaries.map((s) => [s.agentId, s.summary]));

  for (const a of agents) {
    const summary = partySummaries.get(a.id);
    const net = agentBalances.get(a.id);
    const balance = summary?.netLocal ?? net?.netLocal ?? new Decimal(0);
    const first = a.agentName.split(' ')[0];

    const owed = [
      summary?.holdingLocal ?? new Decimal(0),
      summary?.loanToAgentLocal ?? new Decimal(0),
      summary?.tradeReceivableLocal ?? new Decimal(0),
    ].reduce((t, v) => t.plus(v.greaterThan(0) ? v : 0), new Decimal(0));
    const owing = [summary?.loanFromAgentLocal ?? new Decimal(0), summary?.commissionLocal ?? new Decimal(0)].reduce(
      (t, v) => t.plus(v.greaterThan(0) ? v : 0),
      new Decimal(0),
    );

    entries.push({
      key: `agent:${a.id}`,
      name: a.agentName,
      kind: 'Agent',
      detail: ['Agent / counterparty', a.phone].filter(Boolean).join(' · '),
      currency: localCurrency,
      balance,
      balanceMeaning: balance.isNegative() ? 'we owe them' : 'owes us',
      href: `/agents/${a.id}`,
      keywords: `agent counterparty loan clearing commission ${a.phone ?? ''}`,
      usdEquivalent: localCurrency === 'USD' ? null : (summary?.netUsd ?? net?.netUsd ?? null),
      summary: [
        { label: `${first} owes FID`, value: money(owed) },
        { label: `FID owes ${first}`, value: money(owing) },
        {
          label: 'Net position',
          value: balance.isZero()
            ? 'square'
            : balance.isPositive()
              ? `${money(balance)} receivable`
              : `${money(balance)} payable`,
        },
      ],
      children: [],
    });
  }

  const partyRows = new Map(entries.filter((e) => e.kind === 'Agent').map((e) => [e.key, e]));

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
    select: { id: true, name: true, type: true, systemKey: true, currency: true, subledgerType: true, agentId: true },
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
    const entry: LedgerEntry = {
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
    };

    /*
     * An account opened in one person's name belongs under that person.
     *
     * It is still its own account on the balance sheet, in its own
     * classification — this only decides where it is read. The link is the
     * party the account points at, never the words in its name, so
     * correcting a spelling cannot scatter somebody's accounts again.
     */
    const owner = account.agentId ? partyRows.get(`agent:${account.agentId}`) : undefined;
    if (owner) {
      owner.children?.push(entry);
      entry.advancedOnly = true;
    }
    entries.push(entry);
  }

  /*
   * The same man's customer record, where he buys coffee for himself. His
   * own ledger already carries what he owes for it; this puts the customer
   * row under his name too, so the list does not read as two people.
   */
  const linkedCustomers = await prisma.customer.findMany({
    where: { companyId, agentId: { not: null } },
    select: { id: true, agentId: true },
  });
  for (const link of linkedCustomers) {
    const owner = partyRows.get(`agent:${link.agentId}`);
    const row = entries.find((e) => e.key === `customer:${link.id}`);
    if (!owner || !row) continue;
    owner.children?.push({ ...row, detail: `${row.detail || 'Customer'} · what he buys for himself`.trim() });
    row.advancedOnly = true;
  }

  for (const entry of entries) {
    if (entry.children && entry.children.length === 0) delete entry.children;
    entry.children?.sort((a, b) => a.name.localeCompare(b.name));
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
