import { prisma, type Tx } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { dec, type Decimal } from '@/lib/money';
import { formatMoney } from '@/lib/format';
import { AGENT_PREFIX } from '@/lib/ledger-target';
import { agentSetOffAvailable } from '@/lib/services/agent-ledger';
import type { JournalLineInput } from '@/lib/services/accounting';

/**
 * Settling ledger to ledger: a receipt, a payment or a cost settled against
 * another account in the books instead of cash, bank or a cheque.
 *
 * A customer who pays by settling what FID owes him, a supplier paid by the
 * Dubai company on Morocco's behalf, a cost a director paid from his own
 * pocket — money changed hands, but not through any of FID's drawers. The
 * other side of the entry is that person's, that loan's or that company's
 * account, and nothing is recorded in cash or bank.
 *
 * Which accounts may take that side, the same everywhere:
 *
 *   - balance-sheet accounts only (asset, liability, equity) — a settlement
 *     moves a balance between people; it is not income or a cost by itself;
 *   - not a cash or bank drawer — that is paying by cash or bank;
 *   - not a customer, supplier or agent control account — those are kept per
 *     party and are settled through their own documents;
 *   - not a system account, apart from the inter-company loan accounts —
 *     stock, cheques, VAT and the rest are moved only by their own postings;
 *   - kept in the voucher's currency, or in any currency.
 *
 * An agent's own account is offered too: the customer money he holds for the
 * company, on Agent Clearing under his name. Taking money off it — a cost he
 * settled out of his collections — is capped at what he holds, as a hand-over
 * is: more would say he holds money he never collected.
 */

export type LedgerSettlementOption = {
  value: string;
  label: string;
  hint: string;
  keywords: string;
  /** The currency the account is kept in; null takes any. */
  currency: string | null;
};

const ACCOUNT_SELECT = {
  id: true,
  code: true,
  name: true,
  type: true,
  status: true,
  systemKey: true,
  subledgerType: true,
  currency: true,
  agentId: true,
  cashBankAccounts: { select: { id: true } },
} as const;

type Candidate = {
  id: string;
  code: string;
  name: string;
  type: string;
  status: string;
  systemKey: string | null;
  subledgerType: string;
  currency: string | null;
  agentId: string | null;
  cashBankAccounts: Array<{ id: string }>;
};

/** Why an account cannot take the other side, or null when it can. */
function refusal(account: Candidate): string | null {
  if (account.status !== 'ACTIVE') return `${account.name} is inactive.`;
  if (!['ASSET', 'LIABILITY', 'EQUITY'].includes(account.type)) {
    return `${account.name} is an income or expense account; a settlement moves a balance between accounts.`;
  }
  if (account.cashBankAccounts.length > 0) {
    return `${account.name} is a cash or bank account — choose Cash or Bank transfer instead.`;
  }
  if (account.subledgerType !== 'NONE') {
    return `${account.name} is kept per customer, supplier or agent and is settled through their own documents.`;
  }
  if (account.systemKey && !account.systemKey.startsWith('INTERCOMPANY_')) {
    return `${account.name} is moved only by its own postings.`;
  }
  return null;
}

export async function getLedgerSettlementAccounts(companyId: string): Promise<LedgerSettlementOption[]> {
  const accounts = await prisma.account.findMany({
    where: { companyId, status: 'ACTIVE', type: { in: ['ASSET', 'LIABILITY', 'EQUITY'] } },
    orderBy: { name: 'asc' },
    select: ACCOUNT_SELECT,
  });
  const agents = await prisma.agent.findMany({
    where: { companyId, status: 'ACTIVE' },
    orderBy: { agentName: 'asc' },
    select: { id: true, agentName: true, agentCode: true },
  });
  return [
    ...agents.map((agent) => ({
      value: `${AGENT_PREFIX}${agent.id}`,
      label: `${agent.agentName} — agent account`,
      hint: 'what the agent holds for FID',
      keywords: `agent ${agent.agentName} ${agent.agentCode}`,
      currency: null,
    })),
    ...accounts
      .filter((account) => refusal(account) === null)
      .map((account) => ({
        value: account.id,
        label: account.name,
        hint: `${account.type.toLowerCase()}${account.currency ? ` · ${account.currency}` : ''}`,
        keywords: `${account.code} ${account.name}`,
        currency: account.currency,
      })),
  ];
}

/** The chosen account, checked: it belongs here, may take this side, and holds this currency. */
export async function assertLedgerSettlementAccount(
  tx: Tx,
  companyId: string,
  accountId: string | null | undefined,
  currency: string,
): Promise<{ id: string; name: string; agentId: string | null }> {
  if (!accountId) throw new BusinessRuleError('Choose the ledger account on the other side.');
  const account = await tx.account.findFirst({ where: { id: accountId, companyId }, select: ACCOUNT_SELECT });
  if (!account) throw new NotFoundError('Account');
  const why = refusal(account);
  if (why) throw new BusinessRuleError(why);
  if (account.currency && account.currency.toUpperCase() !== currency.toUpperCase()) {
    throw new BusinessRuleError(`${account.name} is kept in ${account.currency}, so it cannot take a ${currency} amount.`);
  }
  return { id: account.id, name: account.name, agentId: account.agentId };
}

export type LedgerTarget = { ledgerAccountId?: string | null; ledgerAgentId?: string | null };

/**
 * The journal line for the other side, checked. `taking` is the amount being
 * taken off an agent's account (a credit to Agent Clearing), which may not
 * exceed what he owes FID in that currency (see agentSetOffAvailable); a
 * debit to it has no limit.
 */
export async function resolveLedgerSettlement(
  tx: Tx,
  companyId: string,
  target: LedgerTarget,
  currency: string,
  taking?: { amount: Decimal | string; rateToUsd: Decimal | string; localCurrency: string },
): Promise<{ line: Pick<JournalLineInput, 'accountId' | 'accountKey' | 'agentId'>; name: string }> {
  if (target.ledgerAgentId) {
    const agent = await tx.agent.findFirst({
      where: { id: target.ledgerAgentId, companyId },
      select: { id: true, agentName: true, status: true },
    });
    if (!agent) throw new NotFoundError('Agent');
    if (agent.status !== 'ACTIVE') throw new BusinessRuleError(`${agent.agentName} is inactive.`);
    if (taking) {
      const available = await agentSetOffAvailable(tx, companyId, agent.id, currency, taking.localCurrency, dec(taking.rateToUsd));
      if (dec(taking.amount).greaterThan(available.plus('0.01'))) {
        throw new BusinessRuleError(
          `${agent.agentName} owes FID ${formatMoney(available, currency)} across his accounts, so no more than that can be set off against his account.`,
        );
      }
    }
    return {
      line: { accountKey: ACCOUNT_KEYS.AGENT_CLEARING, agentId: agent.id },
      name: `${agent.agentName} — agent account`,
    };
  }
  const account = await assertLedgerSettlementAccount(tx, companyId, target.ledgerAccountId, currency);
  return { line: { accountId: account.id, agentId: account.agentId }, name: account.name };
}
