import { Prisma } from '@prisma/client';
import { prisma, transaction } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { dec, sum, toMoney, type Decimal } from '@/lib/money';
import { formatMoney } from '@/lib/format';
import { getExpenseSettlements, type ExpensePaymentStatus } from '@/lib/services/expense-settlement';
import { createPayment, postPayment } from '@/lib/services/payment';
import { createAgentSettlement, postAgentSettlement, getAgentPosition, agentHoldingIn } from '@/lib/services/agent-ledger';
import { assertLedgerSettlementAccount, getLedgerSettlementAccounts } from '@/lib/services/ledger-settlement';
import { LIVE_ENTRY_SQL } from '@/lib/services/journal-visibility';
import { AGENT_PREFIX } from '@/lib/ledger-target';

/**
 * Unpaid expenses: every cost booked now and paid later, what is still owed
 * on each, to whom, and how it was settled.
 *
 * A cost booked unpaid is a cost from the day it is booked — it is in the
 * shipment's costing and the profit and loss at once — and a liability until
 * it is settled. Who it is owed to decides which liability holds it:
 *
 *   nobody named yet   Accrued Expenses ("unpaid expenses, general")
 *   a supplier         Accounts Payable, on that supplier's statement
 *   an agent           Agent Commission Payable, on that agent's ledger
 *
 * Settling one never books the cost again. It reduces the liability, and the
 * other side is whatever actually happened: cash or a bank paid it, a cheque
 * was written, or it was set off against a balance the same party owes FID —
 * money an agent holds, or a ledger account with a debit balance. Every
 * settlement names the cost it settles, so each one can be traced back.
 *
 * Read from the source records every time: the costs already in the books
 * appear here as they are, with nothing to re-enter or backfill.
 */

export type UnpaidPartyKind = 'GENERAL' | 'SUPPLIER' | 'AGENT';
export type UnpaidStatus = 'UNPAID' | 'PARTIAL' | 'SETTLED';
export type AgeBucket = '0–30 days' | '31–60 days' | '61–90 days' | '90+ days';

export const UNPAID_STATUS_LABEL: Record<UnpaidStatus, string> = {
  UNPAID: 'Unpaid',
  PARTIAL: 'Partially Settled',
  SETTLED: 'Settled',
};

export const CONTROL_LABEL: Record<UnpaidPartyKind, string> = {
  GENERAL: 'Unpaid Expenses',
  SUPPLIER: 'Supplier Payables',
  AGENT: 'Agent Commission Due',
};

export type SettlementEvent = {
  id: string;
  href: string;
  number: string;
  date: Date;
  /** Cash, Bank, Cheque, Set-off … in words. */
  method: string;
  /** The drawer, the cheque, or the balance it was set off against. */
  through: string;
  currency: string;
  amount: Decimal;
  memo: string | null;
  by: string | null;
};

export type UnpaidExpenseRow = {
  expenseId: string;
  expenseNumber: string;
  expenseDate: Date;
  kind: 'SHIPMENT' | 'GENERAL';
  shipmentId: string | null;
  shipmentReference: string | null;
  category: string;
  memo: string | null;
  party: { kind: UnpaidPartyKind; id: string | null; name: string };
  control: string;
  currency: string;
  rateLocalPerUsd: Decimal;
  gross: Decimal;
  grossLocal: Decimal;
  grossUsd: Decimal;
  settled: Decimal;
  settledLocal: Decimal;
  outstanding: Decimal;
  outstandingLocal: Decimal;
  status: UnpaidStatus;
  ageDays: number;
  bucket: AgeBucket;
  history: SettlementEvent[];
};

export type UnpaidExpenseLedger = {
  localCurrency: string;
  rows: UnpaidExpenseRow[];
  totals: {
    outstandingLocal: Decimal;
    outstandingCount: number;
    shipmentLocal: Decimal;
    generalLocal: Decimal;
    byBucket: Record<AgeBucket, Decimal>;
  };
  /** Each liability's outstanding costs against its balance in the books. */
  reconciliation: Array<{
    control: string;
    party: UnpaidPartyKind;
    scheduleLocal: Decimal;
    /** Null where the account holds more than costs (Accounts Payable holds purchases too). */
    ledgerLocal: Decimal | null;
    agrees: boolean | null;
  }>;
};

const STATUS_OF: Record<ExpensePaymentStatus, UnpaidStatus> = { PAID: 'SETTLED', PARTIAL: 'PARTIAL', UNPAID: 'UNPAID' };

function bucketOf(days: number): AgeBucket {
  if (days <= 30) return '0–30 days';
  if (days <= 60) return '31–60 days';
  if (days <= 90) return '61–90 days';
  return '90+ days';
}

const METHOD_WORDS: Record<string, string> = {
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank',
  CHEQUE: 'Cheque',
  LEDGER_TRANSFER: 'Set-off',
};

export async function getUnpaidExpenseLedger(companyId: string, asOf: Date = new Date()): Promise<UnpaidExpenseLedger> {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { localCurrency: true } });
  const local = company.localCurrency;

  // Every cost that was booked to be paid later: not paid on the spot, and
  // not settled ledger to ledger when it was booked.
  const expenses = await prisma.expense.findMany({
    where: { companyId, status: 'POSTED', cashBankAccountId: null, ledgerAccountId: null, ledgerAgentId: null },
    include: {
      expenseCategory: { select: { name: true } },
      vendor: { select: { vendorName: true, country: true } },
      payableToAgent: { select: { agentName: true } },
      shipment: { select: { purchaseContract: { select: { contractReference: true } } } },
    },
    orderBy: [{ expenseDate: 'asc' }, { expenseNumber: 'asc' }],
  });
  const ids = expenses.map((e) => e.id);

  const [settlements, paymentEvents, agentEvents, balances] = await Promise.all([
    getExpenseSettlements(companyId, expenses),
    ids.length
      ? prisma.$queryRaw<
          Array<{
            expenseId: string;
            id: string;
            number: string;
            date: Date;
            method: string;
            amount: string;
            currency: string;
            memo: string | null;
            cash: string | null;
            ledger: string | null;
            agent: string | null;
            chequeNumber: string | null;
            chequeStatus: string | null;
            by: string | null;
          }>
        >`
          SELECT pa."expenseId", p."id", p."paymentNumber" AS number, p."paymentDate" AS date,
                 p."paymentMethod"::text AS method, pa."amount"::text AS amount, p."currency",
                 COALESCE(p."description", p."reference") AS memo,
                 cba."name" AS cash, la."name" AS ledger, ag."agentName" AS agent,
                 ch."chequeNumber", ch."status"::text AS "chequeStatus", u."name" AS by
          FROM payment_allocations pa
          JOIN payments p ON p."id" = pa."paymentId"
          LEFT JOIN cash_bank_accounts cba ON cba."id" = p."cashBankAccountId"
          LEFT JOIN accounts la ON la."id" = p."ledgerAccountId"
          LEFT JOIN agents ag ON ag."id" = p."ledgerAgentId"
          LEFT JOIN cheques ch ON ch."paymentId" = p."id"
          LEFT JOIN users u ON u."id" = p."createdById"
          WHERE p."companyId" = ${companyId} AND p."status" = 'POSTED' AND pa."expenseId" = ANY(${ids})
          ORDER BY p."paymentDate", p."paymentNumber"`
      : Promise.resolve([]),
    ids.length
      ? prisma.$queryRaw<
          Array<{
            expenseId: string;
            id: string;
            agentId: string;
            number: string;
            date: Date;
            direction: string;
            amount: string;
            currency: string;
            memo: string | null;
            cash: string | null;
            agent: string;
            by: string | null;
          }>
        >`
          SELECT s."expenseId", s."id", s."agentId", s."settlementNumber" AS number, s."settlementDate" AS date,
                 s."direction"::text AS direction, s."amount"::text AS amount, s."currency",
                 COALESCE(s."notes", s."reference") AS memo, cba."name" AS cash, ag."agentName" AS agent, u."name" AS by
          FROM agent_settlements s
          JOIN agents ag ON ag."id" = s."agentId"
          LEFT JOIN cash_bank_accounts cba ON cba."id" = s."cashBankAccountId"
          LEFT JOIN users u ON u."id" = s."createdById"
          WHERE s."companyId" = ${companyId} AND s."status" = 'POSTED' AND s."expenseId" = ANY(${ids})
          ORDER BY s."settlementDate", s."settlementNumber"`
      : Promise.resolve([]),
    prisma.$queryRaw<Array<{ systemKey: string; balance: string }>>(Prisma.sql`
      SELECT a."systemKey", COALESCE(SUM(jl."creditLocal" - jl."debitLocal"), 0)::text AS balance
      FROM accounts a
      JOIN journal_lines jl ON jl."accountId" = a."id"
      JOIN journal_entries je ON je."id" = jl."journalEntryId" AND ${LIVE_ENTRY_SQL}
      WHERE a."companyId" = ${companyId} AND a."systemKey" IN (${ACCOUNT_KEYS.ACCRUED_EXPENSES}, 'AGENT_COMMISSION_PAYABLE')
      GROUP BY a."systemKey"`),
  ]);

  const history = new Map<string, SettlementEvent[]>();
  const push = (expenseId: string, event: SettlementEvent) => history.set(expenseId, [...(history.get(expenseId) ?? []), event]);
  for (const p of paymentEvents) {
    const cheque = p.chequeNumber ? `Cheque ${p.chequeNumber}${p.chequeStatus ? ` · ${p.chequeStatus.toLowerCase()}` : ''}` : null;
    push(p.expenseId, {
      id: p.id,
      href: `/finance/payments/${p.id}`,
      number: p.number,
      date: p.date,
      method: METHOD_WORDS[p.method] ?? p.method,
      through:
        p.method === 'LEDGER_TRANSFER'
          ? `Set off against ${p.agent ? `${p.agent} — Agent Clearing` : (p.ledger ?? 'another account')}`
          : (cheque ?? p.cash ?? '—'),
      currency: p.currency,
      amount: toMoney(p.amount),
      memo: p.memo,
      by: p.by,
    });
  }
  for (const s of agentEvents) {
    push(s.expenseId, {
      id: s.id,
      href: `/agents/${s.agentId}`,
      number: s.number,
      date: s.date,
      method: s.direction === 'COMMISSION_OFFSET' ? 'Set-off' : s.cash && /cash/i.test(s.cash) ? 'Cash' : 'Bank',
      through: s.direction === 'COMMISSION_OFFSET' ? `Set off against ${s.agent} — Agent Collections` : (s.cash ?? '—'),
      currency: s.currency,
      amount: toMoney(s.amount),
      memo: s.memo,
      by: s.by,
    });
  }

  const day = 86_400_000;
  const rows: UnpaidExpenseRow[] = expenses.map((e) => {
    const s = settlements.get(e.id)!;
    const party: UnpaidExpenseRow['party'] = e.payableToAgentId
      ? { kind: 'AGENT', id: e.payableToAgentId, name: e.payableToAgent?.agentName ?? 'Agent' }
      : e.vendorId
        ? { kind: 'SUPPLIER', id: e.vendorId, name: e.vendor?.vendorName ?? 'Supplier' }
        : { kind: 'GENERAL', id: null, name: 'General / unassigned' };
    const ageDays = Math.max(0, Math.floor((asOf.getTime() - e.expenseDate.getTime()) / day));
    const events = (history.get(e.id) ?? []).sort((a, b) => a.date.getTime() - b.date.getTime());
    // Commission settled from the agent's own page is not tied to one cost;
    // what it covered here is shown as one line, so the history adds up.
    const traced = sum(events.map((ev) => ev.amount));
    if (party.kind === 'AGENT' && s.paid.minus(traced).greaterThan('0.005')) {
      events.push({
        id: `${e.id}-agent-page`,
        href: `/agents/${party.id}`,
        number: '—',
        date: e.expenseDate,
        method: 'Agent page',
        through: `Commission settled on ${party.name}'s page, oldest costs first`,
        currency: e.currency,
        amount: toMoney(s.paid.minus(traced)),
        memo: null,
        by: null,
      });
    }
    return {
      expenseId: e.id,
      expenseNumber: e.expenseNumber,
      expenseDate: e.expenseDate,
      kind: e.kind,
      shipmentId: e.shipmentId,
      shipmentReference: e.shipment?.purchaseContract.contractReference ?? null,
      category: e.expenseCategory.name,
      memo: e.description ?? e.reference,
      party,
      control: CONTROL_LABEL[party.kind],
      currency: e.currency,
      rateLocalPerUsd: dec(e.rateLocalPerUsd),
      gross: s.gross,
      grossLocal: s.grossLocal,
      grossUsd: toMoney(dec(e.amountUsd).plus(dec(e.taxAmountUsd))),
      settled: s.paid,
      settledLocal: s.paidLocal,
      outstanding: s.outstanding,
      outstandingLocal: s.outstandingLocal,
      status: STATUS_OF[s.status],
      ageDays,
      bucket: bucketOf(ageDays),
      history: events,
    };
  });

  const open = rows.filter((r) => r.status !== 'SETTLED');
  const byBucket: Record<AgeBucket, Decimal> = {
    '0–30 days': dec(0),
    '31–60 days': dec(0),
    '61–90 days': dec(0),
    '90+ days': dec(0),
  };
  for (const r of open) byBucket[r.bucket] = toMoney(byBucket[r.bucket].plus(r.outstandingLocal));

  const glOf = (key: string) => {
    const row = balances.find((b) => b.systemKey === key);
    return toMoney(row?.balance ?? 0);
  };
  const scheduleOf = (kind: UnpaidPartyKind) => toMoney(sum(open.filter((r) => r.party.kind === kind).map((r) => r.outstandingLocal)));
  const accruedGl = glOf(ACCOUNT_KEYS.ACCRUED_EXPENSES);
  const commissionGl = glOf('AGENT_COMMISSION_PAYABLE');

  return {
    localCurrency: local,
    rows,
    totals: {
      outstandingLocal: toMoney(sum(open.map((r) => r.outstandingLocal))),
      outstandingCount: open.length,
      shipmentLocal: toMoney(sum(open.filter((r) => r.kind === 'SHIPMENT').map((r) => r.outstandingLocal))),
      generalLocal: toMoney(sum(open.filter((r) => r.kind === 'GENERAL').map((r) => r.outstandingLocal))),
      byBucket,
    },
    reconciliation: [
      {
        control: CONTROL_LABEL.GENERAL,
        party: 'GENERAL',
        scheduleLocal: scheduleOf('GENERAL'),
        ledgerLocal: accruedGl,
        agrees: scheduleOf('GENERAL').minus(accruedGl).abs().lessThanOrEqualTo('0.05'),
      },
      {
        control: CONTROL_LABEL.AGENT,
        party: 'AGENT',
        scheduleLocal: scheduleOf('AGENT'),
        ledgerLocal: commissionGl,
        agrees: scheduleOf('AGENT').minus(commissionGl).abs().lessThanOrEqualTo('0.05'),
      },
      { control: CONTROL_LABEL.SUPPLIER, party: 'SUPPLIER', scheduleLocal: scheduleOf('SUPPLIER'), ledgerLocal: null, agrees: null },
    ],
  };
}

// ---------------------------------------------------------------------------
// Settling one
// ---------------------------------------------------------------------------

export type SettleMethod = 'CASH' | 'BANK' | 'CHEQUE' | 'SET_OFF';

export type SettleUnpaidExpenseInput = {
  companyId: string;
  expenseId: string;
  settlementDate: Date;
  method: SettleMethod;
  /** In the cost's own currency: a cost is settled in the currency it is owed in. */
  amount: string | number;
  /** Units of the cost's currency per 1 USD on the settlement date. */
  rateToUsd: string | number;
  /** Local currency per 1 USD on the settlement date. */
  rateLocalPerUsd: string | number;
  cashBankAccountId?: string | null;
  cheque?: { chequeNumber: string; chequeDate: Date; bankName: string; beneficiary?: string | null } | null;
  /** The balance it is set off against: a ledger account id, or "agent:<id>". */
  setOffAgainst?: string | null;
  memo?: string | null;
};

/** What can be set off against, in a currency, and how much is there. */
export type SetOffSource = { value: string; label: string; hint: string; available: string; currency: string };

/**
 * The balances a cost can be set off against: money an agent holds for FID,
 * and ledger accounts with a debit balance in that currency. For a cost owed
 * to an agent, only what that agent holds — a commission is set off against
 * his own collections.
 */
export async function getSetOffSources(companyId: string, currency: string, agentId?: string | null): Promise<SetOffSource[]> {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { localCurrency: true } });
  const code = currency.toUpperCase();
  const agents = await prisma.agent.findMany({
    where: { companyId, status: 'ACTIVE', ...(agentId ? { id: agentId } : {}) },
    select: { id: true, agentName: true },
    orderBy: { agentName: 'asc' },
  });
  const sources: SetOffSource[] = [];
  for (const agent of agents) {
    const position = await getAgentPosition(prisma as never, companyId, agent.id);
    const held = agentHoldingIn(position, code, company.localCurrency, dec(1));
    // A dollar-rate-free reading is only meaningful in USD or the local currency.
    if (code !== 'USD' && code !== company.localCurrency.toUpperCase()) continue;
    if (held.greaterThan('0.005')) {
      sources.push({
        value: `${AGENT_PREFIX}${agent.id}`,
        label: `${agent.agentName} — Agent Collections`,
        hint: 'customer collections the agent holds',
        available: toMoney(held).toFixed(2),
        currency: code,
      });
    }
  }
  if (agentId) return sources;

  const candidates = (await getLedgerSettlementAccounts(companyId)).filter(
    (o) => !o.value.startsWith(AGENT_PREFIX) && (!o.currency || o.currency.toUpperCase() === code),
  );
  if (candidates.length) {
    const debit = await ledgerDebitBalances(
      companyId,
      candidates.map((c) => c.value),
      code,
    );
    for (const c of candidates) {
      const available = debit.get(c.value) ?? dec(0);
      if (available.greaterThan('0.005')) {
        sources.push({ value: c.value, label: c.label, hint: c.hint, available: toMoney(available).toFixed(2), currency: code });
      }
    }
  }
  return sources;
}

/** Debit balance of each account, in one currency, from live entries. */
async function ledgerDebitBalances(companyId: string, accountIds: string[], currency: string) {
  const rows = await prisma.$queryRaw<Array<{ accountId: string; balance: string }>>(Prisma.sql`
    SELECT jl."accountId", COALESCE(SUM(jl."debit" - jl."credit"), 0)::text AS balance
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId" AND ${LIVE_ENTRY_SQL}
    WHERE je."companyId" = ${companyId} AND jl."accountId" = ANY(${accountIds}) AND jl."currency" = ${currency}
    GROUP BY jl."accountId"`);
  return new Map(rows.map((r) => [r.accountId, dec(r.balance)]));
}

/**
 * Settle an unpaid cost, in full or in part. The cost is never booked again:
 * only its liability goes down, against cash, a bank, a cheque, or a balance
 * the same party owes FID. The user says what happened; the entry follows.
 */
export async function settleUnpaidExpense(input: SettleUnpaidExpenseInput, userId: string) {
  return transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM expenses WHERE "id" = ${input.expenseId} FOR UPDATE`;
    const expense = await tx.expense.findFirst({
      where: { id: input.expenseId, companyId: input.companyId },
      include: {
        vendor: { select: { vendorName: true, country: true } },
        payableToAgent: { select: { agentName: true } },
        expenseCategory: { select: { name: true } },
      },
    });
    if (!expense) throw new NotFoundError('Expense');
    if (expense.status !== 'POSTED') throw new BusinessRuleError('Only a posted cost can be settled.');
    if (expense.cashBankAccountId || expense.ledgerAccountId || expense.ledgerAgentId) {
      throw new BusinessRuleError('This cost was paid when it was booked; there is nothing left to settle.');
    }

    const owed = (await getExpenseSettlements(input.companyId, [expense])).get(expense.id)!;
    const amount = toMoney(input.amount);
    if (amount.lessThanOrEqualTo(0)) throw new BusinessRuleError('Enter an amount greater than zero.');
    if (amount.greaterThan(owed.outstanding.plus('0.005'))) {
      throw new BusinessRuleError(
        `Only ${formatMoney(owed.outstanding, expense.currency)} is still owed on this cost, so no more than that can be settled.`,
      );
    }
    const company = await tx.company.findUniqueOrThrow({ where: { id: input.companyId }, select: { localCurrency: true } });
    const currency = expense.currency;
    const label = `${expense.expenseCategory.name} ${expense.expenseNumber}`;
    const memo = input.memo?.trim() || null;

    // --- Owed to an agent: settled through his account ---------------------
    if (expense.payableToAgentId) {
      if (input.method === 'CHEQUE') {
        throw new BusinessRuleError(
          `A cost owed to ${expense.payableToAgent?.agentName ?? 'an agent'} is paid by cash or bank, or set off against what he holds.`,
        );
      }
      const offset = input.method === 'SET_OFF';
      if (offset) {
        if (input.setOffAgainst && input.setOffAgainst !== `${AGENT_PREFIX}${expense.payableToAgentId}`) {
          throw new BusinessRuleError('A cost owed to an agent is set off against what that agent holds.');
        }
        const position = await getAgentPosition(tx, input.companyId, expense.payableToAgentId);
        const held = agentHoldingIn(position, currency, company.localCurrency, dec(input.rateToUsd));
        if (amount.greaterThan(held.plus('0.01'))) {
          throw new BusinessRuleError(
            `${expense.payableToAgent?.agentName ?? 'The agent'} holds ${formatMoney(held, currency)} for FID, so no more than that can be set off.`,
          );
        }
      }
      const settlement = await createAgentSettlement(
        {
          companyId: input.companyId,
          agentId: expense.payableToAgentId,
          settlementDate: input.settlementDate,
          direction: offset ? 'COMMISSION_OFFSET' : 'COMMISSION',
          cashBankAccountId: offset ? null : input.cashBankAccountId,
          currency,
          amount: amount.toFixed(4),
          rateToUsd: input.rateToUsd,
          rateLocalPerUsd: input.rateLocalPerUsd,
          reference: expense.expenseNumber,
          notes: memo ?? `Settles ${label}`,
          expenseId: expense.id,
        },
        userId,
      );
      await postAgentSettlement({ id: settlement.id, companyId: input.companyId, userId });
      return { kind: 'AGENT_SETTLEMENT' as const, id: settlement.id };
    }

    // --- Owed to a supplier or to nobody yet: a payment put against the cost -
    let ledgerAccountId: string | null = null;
    let ledgerAgentId: string | null = null;
    if (input.method === 'SET_OFF') {
      if (!input.setOffAgainst) throw new BusinessRuleError('Choose the balance to set this off against.');
      if (input.setOffAgainst.startsWith(AGENT_PREFIX)) {
        // Capped at what he holds when the payment posts.
        ledgerAgentId = input.setOffAgainst.slice(AGENT_PREFIX.length);
      } else {
        const account = await assertLedgerSettlementAccount(tx, input.companyId, input.setOffAgainst, currency);
        const available = (await ledgerDebitBalances(input.companyId, [account.id], currency)).get(account.id) ?? dec(0);
        if (amount.greaterThan(available.plus('0.005'))) {
          throw new BusinessRuleError(
            `${account.name} has ${formatMoney(Decimal_max(available, dec(0)), currency)} available to set off, so no more than that can be used.`,
          );
        }
        ledgerAccountId = account.id;
      }
    }
    const method =
      input.method === 'CASH'
        ? 'CASH'
        : input.method === 'BANK'
          ? 'BANK_TRANSFER'
          : input.method === 'CHEQUE'
            ? 'CHEQUE'
            : 'LEDGER_TRANSFER';
    const payment = await createPayment(
      {
        companyId: input.companyId,
        paymentDate: input.settlementDate,
        vendorId: expense.vendorId,
        currency,
        amount: amount.toFixed(4),
        rateToUsd: input.rateToUsd,
        rateLocalPerUsd: input.rateLocalPerUsd,
        paymentMethod: method,
        cashBankAccountId: method === 'CASH' || method === 'BANK_TRANSFER' || method === 'CHEQUE' ? (input.cashBankAccountId ?? null) : null,
        ledgerAccountId,
        ledgerAgentId,
        cheque:
          method === 'CHEQUE' && input.cheque
            ? {
                chequeNumber: input.cheque.chequeNumber,
                chequeDate: input.cheque.chequeDate,
                bankName: input.cheque.bankName,
                beneficiary: input.cheque.beneficiary ?? null,
              }
            : null,
        shipmentId: expense.shipmentId,
        reference: expense.expenseNumber,
        description: memo ?? `Settles ${label}`,
        allocations: [{ expenseId: expense.id, amount: amount.toFixed(4) }],
      },
      userId,
    );
    await postPayment({ id: payment.id, companyId: input.companyId, userId });
    return { kind: 'PAYMENT' as const, id: payment.id };
  });
}

const Decimal_max = (a: Decimal, b: Decimal) => (a.greaterThan(b) ? a : b);
