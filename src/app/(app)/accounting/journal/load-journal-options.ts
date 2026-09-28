import { prisma } from '@/lib/db';
import { getRateDefaults } from '@/lib/services/exchange-rate';
import { Prisma } from '@prisma/client';
import type { AccountOption } from '@/app/(app)/accounting/journal/new/journal-form';
import type { EntryOption } from '@/app/(app)/accounting/journal/new/simple-entry';

/**
 * What a journal voucher can be written against.
 *
 * Shared by the new voucher and the one being corrected, so the two screens
 * cannot drift into offering different accounts.
 */
export async function loadJournalFormOptions(companyId: string) {
  const [accounts, customerRows, agents, rates, vendors, loanAccountRows] = await Promise.all([
    prisma.account.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { code: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        systemKey: true,
        currency: true,
        subledgerType: true,
        // A cash or bank drawer holds one currency and one only, so a voucher
        // in another currency cannot be recorded through it. The form needs to
        // know that while the account is being chosen, not after Post.
        cashBankAccounts: { where: { status: 'ACTIVE' }, select: { currency: true } },
      },
    }),
    prisma.customer.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { customerName: 'asc' },
      select: { id: true, customerName: true, customerCode: true, primaryCurrency: true },
    }),
    prisma.agent.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { agentName: 'asc' },
      select: { id: true, agentName: true },
    }),
    getRateDefaults(companyId),
    prisma.vendor.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { vendorName: 'asc' },
      select: { id: true, vendorName: true, vendorCode: true, primaryCurrency: true },
    }),
    // The accounts loans were actually posted to — "Loan from …", the other
    // FID company — found from the postings, not guessed from names alone.
    prisma.$queryRaw<Array<{ accountId: string }>>(Prisma.sql`
      SELECT DISTINCT jl."accountId"
      FROM journal_lines jl
      JOIN journal_entries je ON je."id" = jl."journalEntryId"
      WHERE je."companyId" = ${companyId} AND je."sourceId" LIKE 'LOAN%' AND jl."cashBankAccountId" IS NULL`),
  ]);

  /*
   * Agents are chosen by name, like any other account. "RADOUAN — agent
   * account" posts to Agent Clearing tagged with the agent, and the agent's
   * own "Loan from / Loan to" accounts carry the tag too, so a journal with an
   * agent lands on that agent's ledger — the same account, never a second one.
   *
   * The tag comes from the account's own party where it has one, and falls
   * back to reading the name only for accounts opened before accounts knew
   * whose they were.
   */
  const byParty = new Map<string, string>();
  const partyAccounts = await prisma.account.findMany({
    where: { companyId, agentId: { not: null } },
    select: { id: true, agentId: true },
  });
  for (const account of partyAccounts) byParty.set(account.id, account.agentId!);

  const agentByName = new Map(agents.map((a) => [a.agentName.trim().toLowerCase(), a.id]));
  const agentOfLoanAccount = (id: string, name: string) => {
    const linked = byParty.get(id);
    if (linked) return linked;
    const match = name.match(/^loan (?:from|to)\s+(.+)$/i);
    return match ? agentByName.get(match[1].trim().toLowerCase()) : undefined;
  };
  const clearing = accounts.find((a) => a.systemKey === 'AGENT_CLEARING');

  const options: AccountOption[] = [
    ...accounts.map((account) => ({
      value: account.id,
      label: account.name,
      hint: account.type.replaceAll('_', ' ').toLowerCase(),
      keywords: `${account.code} ${account.name} ${account.type}`,
      accountType: account.type,
      drawerCurrencies: [...new Set(account.cashBankAccounts.map((d) => d.currency))],
      agentId: agentOfLoanAccount(account.id, account.name),
    })),
    ...(clearing
      ? agents.map((agent) => ({
          value: `agent:${agent.id}`,
          label: `${agent.agentName} — agent account`,
          hint: 'money the agent holds or owes',
          keywords: `agent ${agent.agentName}`,
          accountType: 'ASSET',
          postsTo: clearing.id,
          agentId: agent.id,
        }))
      : []),
  ];

  const customers = customerRows.map((c) => ({
    value: c.id,
    label: c.customerName,
    hint: c.primaryCurrency,
    keywords: c.customerCode,
  }));

  /*
   * The same accounts for the simple General Entry, grouped the way the
   * client thinks of them and searchable by name, party or group. A customer,
   * supplier or agent is chosen by name and posts to the control account in
   * that party's name, so the sub-ledgers stay whole; control accounts are
   * not offered bare.
   */
  const loanAccounts = new Set(loanAccountRows.map((r) => r.accountId));
  const byKey = (key: string) => accounts.find((a) => a.systemKey === key);
  const receivable = byKey('ACCOUNTS_RECEIVABLE');
  const payable = byKey('ACCOUNTS_PAYABLE');
  const commission = byKey('AGENT_COMMISSION_PAYABLE');
  const CONTROL = new Set(['ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'AGENT_CLEARING', 'AGENT_COMMISSION_PAYABLE']);
  const groupOf = (a: (typeof accounts)[number]): string => {
    if (a.cashBankAccounts.length > 0) return 'Cash & Bank';
    if (loanAccounts.has(a.id) || /^loan\b/i.test(a.name) || a.systemKey?.startsWith('INTERCOMPANY_')) return 'Loans & related parties';
    if (a.type === 'EXPENSE') return 'Expenses';
    if (a.type === 'INCOME') return 'Revenue';
    if (a.type === 'EQUITY') return 'Owner & equity';
    return a.type === 'ASSET' ? 'Other assets' : 'Other liabilities';
  };
  const ORDER = ['Cash & Bank', 'Customers', 'Suppliers', 'Agents', 'Loans & related parties', 'Expenses', 'Revenue', 'Owner & equity', 'Other assets', 'Other liabilities'];
  const entryOptions: EntryOption[] = [
    ...accounts
      .filter((a) => !a.systemKey || !CONTROL.has(a.systemKey))
      .map((a) => {
        const drawers = [...new Set(a.cashBankAccounts.map((d) => d.currency))];
        const group = groupOf(a);
        return {
          value: a.id,
          label: a.name,
          hint: drawers.length ? drawers.join(' · ') : (a.currency ?? a.type.toLowerCase()),
          keywords: `${a.code} ${a.name} ${group}`,
          group,
          accountId: a.id,
          agentId: agentOfLoanAccount(a.id, a.name),
          currencies: drawers.length ? drawers : a.currency ? [a.currency] : null,
          cash: drawers.length > 0,
        };
      }),
    ...(receivable
      ? customerRows.map((c) => ({
          value: `customer:${c.id}`,
          label: c.customerName,
          hint: `receivable · ${c.primaryCurrency}`,
          keywords: `customer receivable ${c.customerName} ${c.customerCode}`,
          group: 'Customers',
          accountId: receivable.id,
          customerId: c.id,
          currencies: null,
          cash: false,
        }))
      : []),
    ...(payable
      ? vendors.map((v) => ({
          value: `vendor:${v.id}`,
          label: v.vendorName,
          hint: `payable · ${v.primaryCurrency}`,
          keywords: `supplier payable ${v.vendorName} ${v.vendorCode}`,
          group: 'Suppliers',
          accountId: payable.id,
          vendorId: v.id,
          currencies: null,
          cash: false,
        }))
      : []),
    ...agents.flatMap((agent) => [
      ...(clearing
        ? [
            {
              value: `agent:${agent.id}`,
              label: `${agent.agentName} — agent account`,
              hint: 'customer collections the agent holds',
              keywords: `agent clearing ${agent.agentName}`,
              group: 'Agents',
              accountId: clearing.id,
              agentId: agent.id,
              currencies: null,
              cash: false,
            },
          ]
        : []),
      ...(commission
        ? [
            {
              value: `commission:${agent.id}`,
              label: `${agent.agentName} — commission due`,
              hint: 'commission due to the agent',
              keywords: `agent commission payable ${agent.agentName}`,
              group: 'Agents',
              accountId: commission.id,
              agentId: agent.id,
              currencies: null,
              cash: false,
            },
          ]
        : []),
    ]),
  ].sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group) || a.label.localeCompare(b.label));

  return { options, customers, rates, entryOptions };
}
