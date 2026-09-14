import { transaction, prisma } from '@/lib/db';
import type { Tx } from '@/lib/db';
import { Decimal, dec, toMoney, convertToUsd, convertFromUsd } from '@/lib/money';
import { ACCOUNT_KEYS, DOC_TYPES } from '@/lib/constants';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { nextReference } from '@/lib/services/numbering';
import { postJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { writeAudit } from '@/lib/services/audit';
import type { AgentSettlementDirection } from '@prisma/client';

/**
 * The agent ledger.
 *
 * Some customers never pay the company directly. They hand a cheque to the
 * agent who introduced the trade, written in the agent's own name, and the
 * agent passes the money on later. The client named one: Ridwan.
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
      const position = await getAgentPosition(tx, input.companyId, input.agentId);
      if (amountUsd.greaterThan(position.holdingUsd.plus('0.01'))) {
        throw new BusinessRuleError(
          `${agent.agentName} is holding ${position.holdingUsd.toFixed(2)} USD. ` +
            `Recording ${amountUsd.toFixed(2)} USD would leave the agent owed money he never collected.`,
        );
      }
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
      const position = await getAgentPosition(tx, params.companyId, settlement.agentId);
      if (dec(settlement.amountUsd).greaterThan(position.holdingUsd.plus('0.01'))) {
        throw new BusinessRuleError(
          `${settlement.agent.agentName} is holding ${position.holdingUsd.toFixed(2)} USD. ` +
            `Recording ${dec(settlement.amountUsd).toFixed(2)} USD would leave the agent owed money he never collected.`,
        );
      }
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
