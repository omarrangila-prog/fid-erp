import { transaction, prisma } from '@/lib/db';
import type { Tx } from '@/lib/db';
import { Decimal, dec, toMoney, toRate, convertToUsd, convertFromUsd } from '@/lib/money';
import { ACCOUNT_KEYS, DOC_TYPES } from '@/lib/constants';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { nextReference } from '@/lib/services/numbering';
import { postJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { formatMoney } from '@/lib/format';
import { getRate, getLocalRateForPosting } from '@/lib/services/exchange-rate';
import { findOrCreateAgentLoanAccount, postLoan } from '@/lib/services/loan';
import { writeAudit } from '@/lib/services/audit';
import type { AgentSettlementDirection } from '@prisma/client';

/**
 * The agent ledger.
 *
 * Some customers never pay the company directly. They hand a cheque to the
 * agent who introduced the trade, written in the agent's own name, and the
 * agent passes the money on later. Who that agent is comes from the agent
 * master — names are not written into the posting rules.
 *
 * That is two events, not one, and the system has to hold the gap between
 * them:
 *
 *   the customer pays the agent   Dr Agent Clearing     Cr Accounts Receivable
 *   the agent pays the company    Dr Bank or Cash       Cr Agent Clearing
 *
 * Between the two the customer owes nothing and the company has no cash — what
 * it has is a balance owed by the agent, which is what Agent Clearing holds.
 * Booking the first event straight to bank would state money the company does
 * not have and would leave nothing anywhere answering the only question
 * management asks about this: how much is sitting with whom.
 *
 * Commission runs the same way in the opposite direction. It is a cost of the
 * shipment from the day it is agreed, so it is booked then, against Agent
 * Commission Payable, and that balance is cleared when the agent is actually
 * paid.
 */

export type AgentSettlementInput = {
  companyId: string;
  agentId: string;
  settlementDate: Date;
  direction: AgentSettlementDirection;
  cashBankAccountId: string;
  currency: string;
  amount: string | number;
  rateToUsd: string | number;
  rateLocalPerUsd: string | number;
  reference?: string | null;
  notes?: string | null;
};

/** What an agent owes the company, and what the company owes the agent. */
export type AgentPosition = {
  agentId: string;
  agentCode: string;
  agentName: string;
  /** Collected from customers and not yet handed over. Owed to the company. */
  holdingUsd: Decimal;
  holdingLocal: Decimal;
  /** Commission agreed and not yet paid. Owed to the agent. */
  commissionPayableUsd: Decimal;
  commissionPayableLocal: Decimal;
  /** Positive when the agent owes the company on balance. */
  netUsd: Decimal;
};

async function loadAgent(tx: Tx, companyId: string, agentId: string) {
  const agent = await tx.agent.findFirst({
    where: { id: agentId, companyId },
    select: { id: true, agentName: true, status: true },
  });
  if (!agent) throw new NotFoundError('Agent');
  if (agent.status !== 'ACTIVE') {
    throw new BusinessRuleError(`${agent.agentName} is inactive.`);
  }
  return agent;
}

/**
 * How much of the company's money he is holding, in the currency he is
 * handing over.
 *
 * Compared in USD, a dirham agent handing over every dirham he holds is
 * refused whenever the rate has moved since the collection was booked: MAD
 * 46,000 taken in at 9.85 is USD 4,670, and the same 46,000 handed back at
 * 9.22 reads as USD 4,989 — money he never collected, says the arithmetic.
 * He collected dirhams and is returning dirhams, so dirhams are what the
 * limit is read in.
 */
function holdingIn(position: AgentPosition, currency: string, localCurrency: string, rateToUsd: Decimal): Decimal {
  const code = currency.toUpperCase();
  if (code === 'USD') return position.holdingUsd;
  if (code === localCurrency.toUpperCase()) return position.holdingLocal;
  return convertFromUsd(position.holdingUsd, rateToUsd, code);
}

function assertNotOverCollecting(params: {
  agentName: string;
  position: AgentPosition;
  currency: string;
  localCurrency: string;
  amount: Decimal;
  rateToUsd: Decimal;
}) {
  const held = holdingIn(params.position, params.currency, params.localCurrency, params.rateToUsd);
  if (params.amount.greaterThan(held.plus('0.01'))) {
    throw new BusinessRuleError(
      `${params.agentName} is holding ${formatMoney(held, params.currency)}. ` +
        `Recording ${formatMoney(params.amount, params.currency)} would leave the agent owed money he never ` +
        `collected. If the extra is his own money, record it on his page as a hand-over and say what it is.`,
    );
  }
}

export async function createAgentSettlement(input: AgentSettlementInput, userId: string) {
  return transaction(async (tx) => {
    const company = await getCompanyContext(tx, input.companyId);
    const agent = await loadAgent(tx, input.companyId, input.agentId);

    const account = await tx.cashBankAccount.findFirst({
      where: { id: input.cashBankAccountId, companyId: input.companyId },
      select: { id: true, name: true, currency: true, status: true },
    });
    if (!account) throw new NotFoundError('Cash or bank account');
    if (account.status !== 'ACTIVE') {
      throw new BusinessRuleError(`${account.name} is inactive.`);
    }

    const currency = input.currency.toUpperCase();
    if (account.currency !== currency) {
      throw new BusinessRuleError(
        `${account.name} is held in ${account.currency}, so a ${currency} settlement cannot be recorded against it.`,
      );
    }

    const amount = toMoney(input.amount);
    if (amount.lessThanOrEqualTo(0)) {
      throw new BusinessRuleError('Enter an amount greater than zero.');
    }

    const rateToUsd = dec(input.rateToUsd);
    const amountUsd = currency === 'USD' ? amount : convertToUsd(amount, rateToUsd, currency);
    const localCurrency = company.localCurrency.toUpperCase();
    const rateLocalPerUsd = currency === localCurrency ? rateToUsd : dec(input.rateLocalPerUsd);
    const amountLocal =
      currency === localCurrency ? amount : convertFromUsd(amountUsd, rateLocalPerUsd, localCurrency);

    // Handing over more than is being held would leave the clearing account
    // negative, which says the company owes the agent money it never collected.
    if (input.direction === 'COLLECTION') {
      assertNotOverCollecting({
        agentName: agent.agentName,
        position: await getAgentPosition(tx, input.companyId, input.agentId),
        currency,
        localCurrency,
        amount,
        rateToUsd,
      });
    }

    const settlementNumber = await nextReference(tx, {
      companyId: input.companyId,
      docType: DOC_TYPES.AGENT_SETTLEMENT,
    });

    return tx.agentSettlement.create({
      data: {
        companyId: input.companyId,
        settlementNumber,
        agentId: input.agentId,
        settlementDate: input.settlementDate,
        direction: input.direction,
        cashBankAccountId: input.cashBankAccountId,
        currency,
        amount,
        rateToUsd,
        amountUsd,
        rateLocalPerUsd,
        amountLocal,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        status: 'DRAFT',
        createdById: userId,
      },
    });
  });
}

export async function postAgentSettlement(params: { id: string; companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status"::text FROM agent_settlements
      WHERE "id" = ${params.id} AND "companyId" = ${params.companyId}
      FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundError('Agent settlement');
    if (locked[0].status !== 'DRAFT') {
      throw new BusinessRuleError(`This settlement is already ${locked[0].status.toLowerCase()}.`);
    }

    const settlement = await tx.agentSettlement.findUniqueOrThrow({
      where: { id: params.id },
      include: { agent: true, cashBankAccount: true },
    });
    const company = await getCompanyContext(tx, params.companyId);

    const collecting = settlement.direction === 'COLLECTION';

    await tx.$queryRaw`SELECT "id" FROM agents WHERE "id" = ${settlement.agentId} AND "companyId" = ${params.companyId} FOR UPDATE`;

    if (collecting) {
      assertNotOverCollecting({
        agentName: settlement.agent.agentName,
        position: await getAgentPosition(tx, params.companyId, settlement.agentId),
        currency: settlement.currency,
        localCurrency: company.localCurrency,
        amount: dec(settlement.amount),
        rateToUsd: dec(settlement.rateToUsd),
      });
    } else {
      const position = await getAgentPosition(tx, params.companyId, settlement.agentId);
      if (dec(settlement.amountUsd).greaterThan(position.commissionPayableUsd.plus('0.01'))) {
        throw new BusinessRuleError(
          `${settlement.agent.agentName} is owed ${position.commissionPayableUsd.toFixed(2)} USD of commission. ` +
            `Paying ${dec(settlement.amountUsd).toFixed(2)} USD would overpay him.`,
        );
      }
    }

    await postJournalEntry(tx, {
      companyId: params.companyId,
      entryDate: settlement.settlementDate,
      description: collecting
        ? `${settlement.settlementNumber} — ${settlement.agent.agentName} handed over collections`
        : `${settlement.settlementNumber} — commission paid to ${settlement.agent.agentName}`,
      sourceType: 'AGENT_SETTLEMENT',
      sourceId: settlement.id,
      createdById: params.userId,
      localCurrency: company.localCurrency,
      rateLocalPerUsd: settlement.rateLocalPerUsd,
      lines: collecting
        ? [
            {
              cashBankAccountId: settlement.cashBankAccountId,
              direction: 'DEBIT',
              currency: settlement.currency,
              amount: settlement.amount,
              rateToUsd: settlement.rateToUsd,
              description: `Received from ${settlement.agent.agentName}`,
              agentId: settlement.agentId,
            },
            {
              accountKey: ACCOUNT_KEYS.AGENT_CLEARING,
              direction: 'CREDIT',
              currency: settlement.currency,
              amount: settlement.amount,
              rateToUsd: settlement.rateToUsd,
              description: 'Collections handed over',
              agentId: settlement.agentId,
            },
          ]
        : [
            {
              accountKey: ACCOUNT_KEYS.AGENT_COMMISSION_PAYABLE,
              direction: 'DEBIT',
              currency: settlement.currency,
              amount: settlement.amount,
              rateToUsd: settlement.rateToUsd,
              description: `Commission paid to ${settlement.agent.agentName}`,
              agentId: settlement.agentId,
            },
            {
              cashBankAccountId: settlement.cashBankAccountId,
              direction: 'CREDIT',
              currency: settlement.currency,
              amount: settlement.amount,
              rateToUsd: settlement.rateToUsd,
              description: `Paid from ${settlement.cashBankAccount.name}`,
              agentId: settlement.agentId,
            },
          ],
    });

    const posted = await tx.agentSettlement.update({
      where: { id: settlement.id },
      data: { status: 'POSTED', postedAt: new Date() },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'AGENT_SETTLEMENT_POSTED',
      entityType: 'AgentSettlement',
      entityId: settlement.id,
      after: {
        number: settlement.settlementNumber,
        agent: settlement.agent.agentName,
        direction: settlement.direction,
        amountUsd: settlement.amountUsd.toString(),
      },
    });

    return posted;
  });
}

/** One agent's two balances, straight from the ledger. */
export async function getAgentPosition(tx: Tx, companyId: string, agentId: string): Promise<AgentPosition> {
  const rows = await getAgentPositions(companyId, agentId, tx);
  const found = rows.find((row) => row.agentId === agentId);
  if (found) return found;

  const agent = await tx.agent.findFirstOrThrow({
    where: { id: agentId, companyId },
    select: { id: true, agentCode: true, agentName: true },
  });
  return {
    agentId: agent.id,
    agentCode: agent.agentCode,
    agentName: agent.agentName,
    holdingUsd: new Decimal(0),
    holdingLocal: new Decimal(0),
    commissionPayableUsd: new Decimal(0),
    commissionPayableLocal: new Decimal(0),
    netUsd: new Decimal(0),
  };
}

/**
 * Every agent's position, from the journal rather than a maintained total.
 *
 * Clearing is an asset, so what the agent holds is its debit balance.
 * Commission payable is a liability, so what the company owes is its credit
 * balance. Both are read the same way they would be read off a trial balance,
 * which is the only way they can be guaranteed to agree with one.
 */
export async function getAgentPositions(
  companyId: string,
  agentId?: string,
  client: Tx | typeof prisma = prisma,
): Promise<AgentPosition[]> {
  const rows = await client.$queryRaw<
    Array<{
      agentId: string;
      agentCode: string;
      agentName: string;
      holdingUsd: string;
      holdingLocal: string;
      commissionUsd: string;
      commissionLocal: string;
    }>
  >`
    SELECT a."id"        AS "agentId",
           a."agentCode" AS "agentCode",
           a."agentName" AS "agentName",
           COALESCE(SUM(CASE WHEN acc."systemKey" = 'AGENT_CLEARING'
                             THEN jl."debitUsd" - jl."creditUsd" END), 0)::text     AS "holdingUsd",
           COALESCE(SUM(CASE WHEN acc."systemKey" = 'AGENT_CLEARING'
                             THEN jl."debitLocal" - jl."creditLocal" END), 0)::text AS "holdingLocal",
           COALESCE(SUM(CASE WHEN acc."systemKey" = 'AGENT_COMMISSION_PAYABLE'
                             THEN jl."creditUsd" - jl."debitUsd" END), 0)::text     AS "commissionUsd",
           COALESCE(SUM(CASE WHEN acc."systemKey" = 'AGENT_COMMISSION_PAYABLE'
                             THEN jl."creditLocal" - jl."debitLocal" END), 0)::text AS "commissionLocal"
    FROM agents a
    LEFT JOIN journal_lines jl ON jl."agentId" = a."id"
    LEFT JOIN journal_entries je ON je."id" = jl."journalEntryId" AND je."status" = 'POSTED'
    LEFT JOIN accounts acc ON acc."id" = jl."accountId"
      AND acc."systemKey" IN ('AGENT_CLEARING', 'AGENT_COMMISSION_PAYABLE')
    WHERE a."companyId" = ${companyId}
      AND a."status" = 'ACTIVE'
      AND (${agentId ?? null}::text IS NULL OR a."id" = ${agentId ?? null})
    GROUP BY a."id", a."agentCode", a."agentName"
    ORDER BY a."agentName"`;

  return rows.map((row) => {
    const holdingUsd = toMoney(row.holdingUsd);
    const commissionPayableUsd = toMoney(row.commissionUsd);
    return {
      agentId: row.agentId,
      agentCode: row.agentCode,
      agentName: row.agentName,
      holdingUsd,
      holdingLocal: toMoney(row.holdingLocal),
      commissionPayableUsd,
      commissionPayableLocal: toMoney(row.commissionLocal),
      netUsd: toMoney(holdingUsd.minus(commissionPayableUsd)),
    };
  });
}

/** Every movement on one agent's two accounts, oldest first, with a running balance. */
export async function getAgentStatement(params: { companyId: string; agentId: string }) {
  const rows = await prisma.$queryRaw<
    Array<{
      entryDate: Date;
      entryNumber: string;
      sourceType: string;
      description: string;
      accountKey: string;
      debitUsd: string;
      creditUsd: string;
      customerName: string | null;
    }>
  >`
    SELECT je."entryDate", je."entryNumber", je."sourceType"::text AS "sourceType",
           jl."description", acc."systemKey" AS "accountKey",
           jl."debitUsd"::text AS "debitUsd", jl."creditUsd"::text AS "creditUsd",
           c."customerName"
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts acc ON acc."id" = jl."accountId"
    LEFT JOIN customers c ON c."id" = jl."customerId"
    WHERE je."companyId" = ${params.companyId}
      AND je."status" = 'POSTED'
      AND jl."agentId" = ${params.agentId}
      AND acc."systemKey" IN ('AGENT_CLEARING', 'AGENT_COMMISSION_PAYABLE')
    ORDER BY je."entryDate", je."entryNumber"`;

  let holding = new Decimal(0);
  let commission = new Decimal(0);

  return rows.map((row) => {
    const debit = dec(row.debitUsd);
    const credit = dec(row.creditUsd);

    if (row.accountKey === 'AGENT_CLEARING') holding = toMoney(holding.plus(debit).minus(credit));
    else commission = toMoney(commission.plus(credit).minus(debit));

    return {
      entryDate: row.entryDate,
      entryNumber: row.entryNumber,
      sourceType: row.sourceType,
      description: row.description,
      customerName: row.customerName,
      account: row.accountKey === 'AGENT_CLEARING' ? ('CLEARING' as const) : ('COMMISSION' as const),
      debitUsd: toMoney(debit),
      creditUsd: toMoney(credit),
      holdingUsd: holding,
      commissionPayableUsd: commission,
    };
  });
}

/**
 * Money handed over by an agent, which may be more than he was holding.
 *
 * He collects customers' cheques for the company, and when he hands money
 * over it settles what he holds. Sometimes he hands over more — the rest is
 * his own money, lent to the company. The system must not decide that for
 * itself: it settles what the clearing account says he holds, and the caller
 * has to say what the excess is. Anything unexplained is refused rather than
 * guessed, because a wrong guess here is a wrong balance sheet.
 */
export async function recordAgentHandover(input: {
  companyId: string;
  userId: string;
  agentId: string;
  settlementDate: Date;
  cashBankAccountId: string;
  currency: string;
  amount: string | number;
  rateToUsd: string | number;
  rateLocalPerUsd: string | number;
  reference?: string | null;
  notes?: string | null;
  /** What the amount beyond what he holds is. Required when there is one. */
  excess?: 'LOAN' | null;
}): Promise<{ settlementId: string | null; loanEntryId: string | null; settled: Decimal; lent: Decimal }> {
  const total = toMoney(input.amount);
  if (total.lessThanOrEqualTo(0)) throw new BusinessRuleError('Enter an amount greater than zero.');

  const currency = input.currency.toUpperCase();
  const { agentName, holdingOwn, bankCurrency } = await transaction(async (tx) => {
    const agent = await loadAgent(tx, input.companyId, input.agentId);
    const company = await getCompanyContext(tx, input.companyId);
    const position = await getAgentPosition(tx, input.companyId, input.agentId);
    const bank = await tx.cashBankAccount.findFirst({
      where: { id: input.cashBankAccountId, companyId: input.companyId },
      select: { currency: true },
    });
    if (!bank) throw new NotFoundError('Cash or bank account');
    // What he holds, in the currency being handed over.
    const own = holdingIn(position, currency, company.localCurrency, dec(input.rateToUsd));
    return { agentName: agent.agentName, holdingOwn: toMoney(own), bankCurrency: bank.currency.toUpperCase() };
  });

  /*
   * What can be settled, never below nothing. A clearing balance that has
   * somehow gone negative would otherwise make the "excess" larger than the
   * money in hand, and the company would book a loan bigger than what he
   * handed over.
   */
  const held = holdingOwn.greaterThan(0) ? holdingOwn : toMoney(0);
  const settled = total.greaterThan(held) ? held : total;
  const lent = toMoney(total.minus(settled));

  if (lent.greaterThan('0.005') && input.excess !== 'LOAN') {
    throw new BusinessRuleError(
      `${agentName} is holding ${formatMoney(held, input.currency)} for the company, and this hand-over is ` +
        `${formatMoney(total, input.currency)}. Say what the extra ${formatMoney(lent, input.currency)} is — money ` +
        `he is lending the company, or an amount entered in error — because the system will not decide it for you.`,
    );
  }

  let settlementId: string | null = null;
  if (settled.greaterThan('0.005')) {
    const settlement = await createAgentSettlement(
      {
        companyId: input.companyId,
        agentId: input.agentId,
        settlementDate: input.settlementDate,
        direction: 'COLLECTION',
        cashBankAccountId: input.cashBankAccountId,
        currency: input.currency,
        amount: settled.toString(),
        rateToUsd: input.rateToUsd,
        rateLocalPerUsd: input.rateLocalPerUsd,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
      },
      input.userId,
    );
    await postAgentSettlement({ id: settlement.id, companyId: input.companyId, userId: input.userId });
    settlementId = settlement.id;
  }

  let loanEntryId: string | null = null;
  if (lent.greaterThan('0.005')) {
    // The loan is struck in the currency he handed over; the bank may be in
    // another, so tell the loan what one unit of his money is worth there.
    const bankPerUsd =
      bankCurrency === 'USD'
        ? dec(1)
        : ((await getRate({ companyId: input.companyId, quoteCurrency: bankCurrency, asOf: input.settlementDate })) ??
          (await getRate({ companyId: input.companyId, quoteCurrency: bankCurrency })) ??
          dec(1));
    const exchangeRate = bankCurrency === currency ? dec(1) : toRate(bankPerUsd.dividedBy(dec(input.rateToUsd)));
    /*
     * The settlement above is already posted by now, and this is a second
     * entry. If it fails — a closed period, a rate the loan needs — the money
     * that was collected has still been received, so the error says which
     * part landed rather than leaving somebody to guess.
     */
    const loan = await postLoan({
      exchangeRate: exchangeRate.toString(),
      companyId: input.companyId,
      userId: input.userId,
      loanDate: input.settlementDate,
      direction: 'RECEIVED',
      agentId: input.agentId,
      cashBankAccountId: input.cashBankAccountId,
      currency: input.currency,
      amount: lent.toString(),
      reference: input.reference ?? null,
      description: input.notes?.trim() || `Lent to the company by ${agentName} beyond the collections handed over`,
    }).catch((error: unknown) => {
      if (settlementId) {
        throw new BusinessRuleError(
          `${formatMoney(settled, input.currency)} of collections was recorded, but the remaining ` +
            `${formatMoney(lent, input.currency)} could not be posted as a loan: ` +
            `${error instanceof Error ? error.message : String(error)}. Record that part on its own from Loans.`,
        );
      }
      throw error;
    });
    loanEntryId = loan.entry.id;
  }

  return { settlementId, loanEntryId, settled, lent };
}

/**
 * Settle what the agent owes the company against what the company owes him.
 *
 * Never automatic. Showing a net position is a convenience; moving one
 * balance against the other is a decision somebody has to make, so it is an
 * action with an amount and a reason:
 *
 *     Dr Loan from <agent>       the loan the company owes him falls
 *     Cr Agent Clearing          what he owes the company falls
 *
 * Capped at the smaller of the two, so neither side can be driven past nil.
 */
export async function offsetAgentBalances(input: {
  companyId: string;
  userId: string;
  agentId: string;
  date: Date;
  amount: string | number;
  reason: string;
}) {
  const amount = toMoney(input.amount);
  if (amount.lessThanOrEqualTo(0)) throw new BusinessRuleError('Enter an amount greater than zero.');
  if (!input.reason?.trim()) throw new BusinessRuleError('Say why these balances are being settled against each other.');

  return transaction(async (tx) => {
    const agent = await loadAgent(tx, input.companyId, input.agentId);
    const company = await getCompanyContext(tx, input.companyId);

    // Hold the agent while his two balances are read and moved, so two
    // people pressing this at once cannot each offset the same amount.
    await tx.$queryRaw`SELECT "id" FROM agents WHERE "id" = ${input.agentId} AND "companyId" = ${input.companyId} FOR UPDATE`;

    const { getAgentLedger } = await import('@/lib/services/agent-account');
    const { summary } = await getAgentLedger({ companyId: input.companyId, agentId: input.agentId });

    const holding = summary.holdingLocal;
    const loan = summary.loanFromAgentLocal;
    const most = holding.lessThan(loan) ? holding : loan;
    if (most.lessThanOrEqualTo(0)) {
      throw new BusinessRuleError(
        `There is nothing to settle: ${agent.agentName} holds ${formatMoney(holding, company.localCurrency)} for ` +
          `the company and the company owes him ${formatMoney(loan, company.localCurrency)}.`,
      );
    }
    if (amount.greaterThan(most.plus('0.005'))) {
      throw new BusinessRuleError(
        `Only ${formatMoney(most, company.localCurrency)} can be settled against each other: ${agent.agentName} ` +
          `holds ${formatMoney(holding, company.localCurrency)} and is owed ${formatMoney(loan, company.localCurrency)}.`,
      );
    }

    const loanAccount = await findOrCreateAgentLoanAccount(tx, {
      companyId: input.companyId,
      userId: input.userId,
      agentName: agent.agentName,
      agentId: agent.id,
      side: 'FROM',
    });

    const rateLocalPerUsd = await getLocalRateForPosting({
      companyId: input.companyId,
      localCurrency: company.localCurrency,
      asOf: input.date,
    });

    const entry = await postJournalEntry(tx, {
      companyId: input.companyId,
      entryDate: input.date,
      description: `Settled against each other for ${agent.agentName} — ${input.reason.trim()}`,
      sourceType: 'MANUAL',
      sourceId: `agent-offset:${input.agentId}:${Date.now()}`,
      createdById: input.userId,
      localCurrency: company.localCurrency,
      rateLocalPerUsd,
      lines: [
        {
          accountId: loanAccount.id,
          direction: 'DEBIT',
          currency: company.localCurrency,
          amount,
          rateToUsd: rateLocalPerUsd,
          agentId: input.agentId,
          description: `Loan repaid by keeping collections he holds — ${input.reason.trim()}`,
        },
        {
          accountKey: ACCOUNT_KEYS.AGENT_CLEARING,
          direction: 'CREDIT',
          currency: company.localCurrency,
          amount,
          rateToUsd: rateLocalPerUsd,
          agentId: input.agentId,
          description: `Collections kept against the loan — ${input.reason.trim()}`,
        },
      ],
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId: input.userId,
      action: 'AGENT_BALANCES_OFFSET',
      entityType: 'Agent',
      entityId: input.agentId,
      after: { amount: amount.toString(), currency: company.localCurrency, reason: input.reason.trim(), entry: entry.entryNumber },
    });

    return entry;
  }, 60_000);
}
