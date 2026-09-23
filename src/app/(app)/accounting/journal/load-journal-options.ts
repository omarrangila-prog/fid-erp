import { prisma } from '@/lib/db';
import { getRateDefaults } from '@/lib/services/exchange-rate';
import type { AccountOption } from '@/app/(app)/accounting/journal/new/journal-form';

/**
 * What a journal voucher can be written against.
 *
 * Shared by the new voucher and the one being corrected, so the two screens
 * cannot drift into offering different accounts.
 */
export async function loadJournalFormOptions(companyId: string) {
  const [accounts, customerRows, agents, rates] = await Promise.all([
    prisma.account.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { code: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        systemKey: true,
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

  return { options, customers, rates };
}
