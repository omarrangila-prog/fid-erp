import { prisma } from '@/lib/db';
import { dec, toMoney, type Decimal } from '@/lib/money';
import { getCommissionPaidByExpense } from '@/lib/services/agent-commission';
import { supplierGrossPayable } from '@/lib/services/tax';
import { LIVE_ENTRY_SQL } from '@/lib/services/journal-visibility';

/**
 * Whether a cost has been paid, and from where — one answer for every screen.
 *
 * The expense list, the shipment page and the shipment cost report each
 * worked this out for themselves, and two of them called a bill "paid" the
 * moment any payment touched it: MAD 10,000 owed with MAD 1,000 paid read as
 * Paid. The rules, once:
 *
 *   paid on the spot       a cash or bank account was named when the cost was
 *                          booked: the money left then. Paid.
 *   ledger to ledger       settled at once against another account in the
 *                          books (a person, a loan, the other company). Paid.
 *   owed to an agent       settled by commission paid to that agent.
 *   owed to a supplier,    settled by posted payments allocated to it; a
 *   or to nobody yet       bounced or cancelled cheque settles nothing.
 *
 * A journal voucher can settle too: one that debits Accrued Expenses, or an
 * agent's commission payable, has paid what those accounts hold. It names no
 * cost, so it goes to the oldest still owed — the same way unnamed commission
 * settlements always have — and the costs then read paid exactly when the
 * ledger says the money has gone.
 *
 * What remains decides the status: nothing left is Paid, something paid but
 * not all is Partially settled, nothing paid is Unpaid. Whether a cost is paid
 * never changes whether it is a cost — an unpaid clearing bill is in the
 * shipment's landed cost from the day it is booked.
 *
 * Amounts are kept in the cost's own currency, and restated in the company's
 * currency at the cost's own rate, so totals across MAD and USD bills add up
 * without converting anything at today's rate.
 */

export type ExpensePaymentStatus = 'PAID' | 'PARTIAL' | 'UNPAID';

export const EXPENSE_PAYMENT_LABEL: Record<ExpensePaymentStatus, string> = {
  PAID: 'Paid',
  PARTIAL: 'Partially Settled',
  UNPAID: 'Unpaid',
};

export type ExpenseSettlement = {
  status: ExpensePaymentStatus;
  /** What is owed in all, in the cost's own currency. */
  gross: Decimal;
  paid: Decimal;
  outstanding: Decimal;
  /** The same three at the cost's own rate, in the company's currency. */
  grossLocal: Decimal;
  paidLocal: Decimal;
  outstandingLocal: Decimal;
  /** Where the money came from, when it has gone: an account, or several. */
  paidFrom: string | null;
  /** Owed to an agent rather than a supplier: settled through the agent's account. */
  owedToAgent: boolean;
  /** Of what is paid, the part settled by journal vouchers, in the company's currency. */
  journalLocal: Decimal;
  /**
   * Of what is still owed, the part a journal voucher moved to another party's
   * account (a supplier, an agent's commission due, a loan) — still unpaid,
   * now owed there. In the company's currency.
   */
  transferredLocal: Decimal;
  transferredTo: string[];
  /** System keys of the accounts it moved to. */
  transferredToKeys: string[];
};

type SettlementInput = {
  id: string;
  status: string;
  currency: string;
  amount: Decimal;
  amountUsd: Decimal;
  amountLocal: Decimal;
  taxAmount: Decimal;
  taxAmountUsd: Decimal;
  cashBankAccountId: string | null;
  cashBankAccount?: { name: string } | null;
  ledgerAccountId?: string | null;
  ledgerAccount?: { name: string } | null;
  ledgerAgentId?: string | null;
  ledgerAgent?: { agentName: string } | null;
  payableToAgentId: string | null;
  vendorId?: string | null;
  vendor?: { country: string | null } | null;
};

/**
 * Journal vouchers against Accrued Expenses, applied to the costs booked
 * there — owed to nobody in particular — in the company's currency, per cost.
 *
 * A voucher that debits Accrued Expenses does one of two different things,
 * told apart by where its credit goes:
 *
 *   settles — the credit is to something that is not a liability: cash, a
 *   bank, an agent's collections, a receivable, a written-back cost. The
 *   liability is gone; the cost is (partly) paid.
 *
 *   transfers — the credit is to another liability: a supplier, an agent's
 *   commission due, a loan from somebody. The debt has only moved to that
 *   party's account; nothing is paid, and the cost stays Unpaid, marked as
 *   transferred.
 *
 * In the order things were posted: a voucher acts on what was owed when it
 * was posted, oldest cost first, after the payments allocated to each. A cost
 * booked later, even back-dated, cannot have been paid by an earlier voucher,
 * so booking one never turns a cost that reads Paid back into Unpaid. Money
 * paid beyond what was owed waits as an advance for the next cost.
 */
export type AccruedJournalAllocation = {
  settled: Map<string, Decimal>;
  /** `keys`: the system keys of the accounts it moved to (e.g. AGENT_COMMISSION_PAYABLE), for reconciling them. */
  transferred: Map<string, { amount: Decimal; to: string[]; keys: string[] }>;
};

export async function accruedJournalAllocation(companyId: string, companyCountry: string | null): Promise<AccruedJournalAllocation> {
  const settledBy = new Map<string, Decimal>();
  const transferredBy = new Map<string, { amount: Decimal; to: Set<string>; keys: Set<string> }>();
  const result = (): AccruedJournalAllocation => ({
    settled: new Map([...settledBy].map(([id, v]) => [id, toMoney(v)])),
    transferred: new Map([...transferredBy].map(([id, v]) => [id, { amount: toMoney(v.amount), to: [...v.to], keys: [...v.keys] }])),
  });
  const vouchers = await prisma.$queryRaw<Array<{ postedAt: Date; accrued: string; otherLiabilities: string; liabilityNames: string | null; liabilityKeys: string | null }>>`
    SELECT je."postedAt",
           COALESCE(SUM(CASE WHEN acc."systemKey" = 'ACCRUED_EXPENSES' THEN jl."debitLocal" - jl."creditLocal" ELSE 0 END), 0)::text AS accrued,
           COALESCE(SUM(CASE WHEN acc."type" = 'LIABILITY' AND COALESCE(acc."systemKey", '') <> 'ACCRUED_EXPENSES'
                             THEN jl."creditLocal" - jl."debitLocal" ELSE 0 END), 0)::text AS "otherLiabilities",
           string_agg(DISTINCT CASE WHEN acc."type" = 'LIABILITY' AND COALESCE(acc."systemKey", '') <> 'ACCRUED_EXPENSES' AND jl."creditLocal" > 0
                                    THEN acc."name" END, ', ') AS "liabilityNames",
           string_agg(DISTINCT CASE WHEN acc."type" = 'LIABILITY' AND COALESCE(acc."systemKey", '') <> 'ACCRUED_EXPENSES' AND jl."creditLocal" > 0
                                    THEN COALESCE(acc."systemKey", 'OTHER') END, ',') AS "liabilityKeys"
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts acc ON acc."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND ${LIVE_ENTRY_SQL}
      AND je."sourceType" = 'MANUAL'
      AND EXISTS (SELECT 1 FROM journal_lines x JOIN accounts xa ON xa."id" = x."accountId"
                  WHERE x."journalEntryId" = je."id" AND xa."systemKey" = 'ACCRUED_EXPENSES')
    GROUP BY je."id", je."postedAt"
    ORDER BY je."postedAt", je."id"`;
  if (!vouchers.some((v) => dec(v.accrued).greaterThan('0.005'))) return result();

  const accrued = await prisma.expense.findMany({
    where: { companyId, status: 'POSTED', cashBankAccountId: null, ledgerAccountId: null, ledgerAgentId: null, vendorId: null, payableToAgentId: null },
    orderBy: [{ expenseDate: 'asc' }, { createdAt: 'asc' }, { expenseNumber: 'asc' }],
    select: { id: true, amount: true, taxAmount: true, amountUsd: true, taxAmountUsd: true, amountLocal: true, postedAt: true, createdAt: true },
  });
  if (accrued.length === 0) return result();
  const allocations = await prisma.$queryRaw<Array<{ expenseId: string; amount: string }>>`
    SELECT pa."expenseId", COALESCE(SUM(pa."amount"), 0)::text AS amount
    FROM payment_allocations pa
    JOIN payments p ON p."id" = pa."paymentId"
    WHERE p."companyId" = ${companyId} AND p."status" = 'POSTED'
      AND pa."expenseId" = ANY(${accrued.map((e) => e.id)})
      AND NOT EXISTS (
        SELECT 1 FROM cheques ch
        WHERE ch."paymentId" = p."id" AND ch.status IN ('BOUNCED', 'CANCELLED')
      )
    GROUP BY pa."expenseId"`;
  const allocated = new Map(allocations.map((a) => [a.expenseId, dec(a.amount)]));

  // What each cost still owes after its own payments, in the company's currency.
  const owing = new Map<string, Decimal>();
  for (const e of accrued) {
    const localPerUnit = dec(e.amount).isZero() ? dec(0) : dec(e.amountLocal).dividedBy(dec(e.amount));
    const gross = supplierGrossPayable({
      netAmount: e.amount,
      taxAmount: e.taxAmount,
      netAmountUsd: e.amountUsd,
      taxAmountUsd: e.taxAmountUsd,
      vendorCountry: null,
      companyCountry,
    }).amount;
    owing.set(e.id, Decimal_max(toMoney(gross.minus(allocated.get(e.id) ?? 0).times(localPerUnit)), dec(0)));
  }

  // Costs and vouchers on one timeline; a cost joins the queue when posted.
  const bookedAt = (e: (typeof accrued)[number]) => (e.postedAt ?? e.createdAt).getTime();
  type Event = { at: number; cost: string | null; settle: Decimal; transfer: Decimal; to: string[]; keys: string[] };
  const events: Event[] = [
    ...accrued.map((e) => ({ at: bookedAt(e), cost: e.id, settle: dec(0), transfer: dec(0), to: [] as string[], keys: [] as string[] })),
    ...vouchers.map((v) => {
      const net = dec(v.accrued);
      // Of what came off Accrued Expenses, the part that went to another liability only moved.
      const transfer = net.greaterThan(0) ? Decimal_min(net, Decimal_max(dec(v.otherLiabilities), dec(0))) : dec(0);
      return {
        at: v.postedAt.getTime(),
        cost: null,
        settle: net.minus(transfer),
        transfer,
        to: v.liabilityNames ? v.liabilityNames.split(', ') : [],
        keys: v.liabilityKeys ? v.liabilityKeys.split(',') : [],
      };
    }),
  ].sort((a, b) => a.at - b.at || (a.cost ? -1 : 1));
  const open: string[] = [];
  const order = new Map(accrued.map((e, i) => [e.id, i]));
  let available = dec(0);
  let moving = dec(0);
  let movingTo: string[] = [];
  let movingKeys: string[] = [];
  const left = (id: string) => owing.get(id)!.minus(settledBy.get(id) ?? 0).minus(transferredBy.get(id)?.amount ?? 0);
  const applyOpen = () => {
    open.sort((a, b) => order.get(a)! - order.get(b)!);
    for (const id of open) {
      if (available.lessThanOrEqualTo('0.005')) break;
      const take = Decimal_min(available, left(id));
      if (take.greaterThan(0)) settledBy.set(id, (settledBy.get(id) ?? dec(0)).plus(take));
      available = available.minus(take);
    }
    for (const id of open) {
      if (moving.lessThanOrEqualTo('0.005')) break;
      const take = Decimal_min(moving, left(id));
      if (take.greaterThan(0)) {
        const was = transferredBy.get(id) ?? { amount: dec(0), to: new Set<string>(), keys: new Set<string>() };
        was.amount = was.amount.plus(take);
        for (const name of movingTo) was.to.add(name);
        for (const key of movingKeys) was.keys.add(key);
        transferredBy.set(id, was);
      }
      moving = moving.minus(take);
    }
  };
  for (const event of events) {
    if (event.cost) open.push(event.cost);
    else {
      available = available.plus(event.settle);
      moving = moving.plus(event.transfer);
      if (event.transfer.greaterThan(0)) {
        movingTo = event.to;
        movingKeys = event.keys;
      }
    }
    applyOpen();
  }
  return result();
}

/** What journal vouchers genuinely settled, per cost — transfers to another payable excluded. */
export async function accruedJournalSettlements(companyId: string, companyCountry: string | null): Promise<Map<string, Decimal>> {
  return (await accruedJournalAllocation(companyId, companyCountry)).settled;
}

export async function getExpenseSettlements(
  companyId: string,
  expenses: SettlementInput[],
): Promise<Map<string, ExpenseSettlement>> {
  const posted = expenses.filter((e) => e.status === 'POSTED');
  const owedIds = posted
    .filter((e) => !e.cashBankAccountId && !e.ledgerAccountId && !e.ledgerAgentId && !e.payableToAgentId)
    .map((e) => e.id);

  const [company, allocations, commission] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { country: true } }),
    owedIds.length
      ? prisma.$queryRaw<Array<{ expenseId: string; amount: string; accounts: string | null }>>`
          SELECT pa."expenseId",
                 COALESCE(SUM(pa."amount"), 0)::text AS amount,
                 string_agg(DISTINCT COALESCE(cba."name", la."name"), ', ') AS accounts
          FROM payment_allocations pa
          JOIN payments p ON p."id" = pa."paymentId"
          LEFT JOIN cash_bank_accounts cba ON cba."id" = p."cashBankAccountId"
          LEFT JOIN accounts la ON la."id" = p."ledgerAccountId"
          WHERE p."companyId" = ${companyId} AND p."status" = 'POSTED'
            AND pa."expenseId" = ANY(${owedIds})
            AND NOT EXISTS (
              SELECT 1 FROM cheques ch
              WHERE ch."paymentId" = p."id" AND ch.status IN ('BOUNCED', 'CANCELLED')
            )
          GROUP BY pa."expenseId"`
      : Promise.resolve([]),
    posted.some((e) => e.payableToAgentId) ? getCommissionPaidByExpense(companyId) : Promise.resolve(new Map<string, Decimal>()),
  ]);
  const journals: AccruedJournalAllocation = posted.some((e) => owedIds.includes(e.id) && !e.vendorId)
    ? await accruedJournalAllocation(companyId, company.country)
    : { settled: new Map(), transferred: new Map() };
  const byExpense = new Map(allocations.map((a) => [a.expenseId, a]));

  const result = new Map<string, ExpenseSettlement>();
  for (const e of posted) {
    const localPerUnit = dec(e.amount).isZero() ? dec(0) : dec(e.amountLocal).dividedBy(dec(e.amount));
    let gross: Decimal;
    let paid: Decimal;
    let paidFrom: string | null = null;
    let journalLocal = dec(0);
    let transferredLocal = dec(0);
    let transferredTo: string[] = [];
    let transferredToKeys: string[] = [];

    if (e.cashBankAccountId || e.ledgerAccountId || e.ledgerAgentId) {
      gross = toMoney(dec(e.amount).plus(dec(e.taxAmount)));
      paid = gross;
      paidFrom = e.cashBankAccountId
        ? (e.cashBankAccount?.name ?? null)
        : `Ledger to ledger · ${e.ledgerAgent ? `${e.ledgerAgent.agentName} — agent account` : (e.ledgerAccount?.name ?? 'another account')}`;
    } else if (e.payableToAgentId) {
      // Commission is settled in USD through the agent's account; restate the
      // share settled into the cost's own currency.
      gross = toMoney(dec(e.amount));
      const usd = dec(e.amountUsd);
      const settledUsd = dec(commission.get(e.id) ?? 0);
      paid = usd.isZero() ? dec(0) : toMoney(gross.times(Decimal_min(settledUsd, usd)).dividedBy(usd));
    } else {
      gross = supplierGrossPayable({
        netAmount: e.amount,
        taxAmount: e.taxAmount,
        netAmountUsd: e.amountUsd,
        taxAmountUsd: e.taxAmountUsd,
        vendorCountry: e.vendor?.country,
        companyCountry: company.country,
      }).amount;
      const row = byExpense.get(e.id);
      paid = toMoney(dec(row?.amount ?? 0));
      paidFrom = row?.accounts ?? null;
      const byJournal = journals.settled.get(e.id);
      if (byJournal && !localPerUnit.isZero()) {
        journalLocal = byJournal;
        paid = toMoney(paid.plus(byJournal.dividedBy(localPerUnit)));
        paidFrom = [paidFrom, 'Journal entry (JV)'].filter(Boolean).join(', ');
      }
      // Moved to another party's account by a voucher: not paid, and it says where it went.
      const moved = journals.transferred.get(e.id);
      if (moved) {
        transferredLocal = moved.amount;
        transferredTo = moved.to;
        transferredToKeys = moved.keys;
      }
    }

    const outstanding = Decimal_max(toMoney(gross.minus(paid)), dec(0));
    const status: ExpensePaymentStatus = outstanding.lessThanOrEqualTo('0.005')
      ? 'PAID'
      : paid.greaterThan('0.005')
        ? 'PARTIAL'
        : 'UNPAID';
    // The cost's own rate for the tax as well as the net: tax is billed in
    // the same currency on the same day.
    const grossLocal = toMoney(gross.times(localPerUnit));
    const paidLocal = toMoney(Decimal_min(paid, gross).times(localPerUnit));

    result.set(e.id, {
      status,
      gross,
      paid: Decimal_min(paid, gross),
      outstanding,
      grossLocal,
      paidLocal,
      outstandingLocal: toMoney(grossLocal.minus(paidLocal)),
      paidFrom,
      owedToAgent: Boolean(e.payableToAgentId),
      journalLocal,
      transferredLocal,
      transferredTo,
      transferredToKeys,
    });
  }
  return result;
}

const Decimal_min = (a: Decimal, b: Decimal) => (a.lessThan(b) ? a : b);
const Decimal_max = (a: Decimal, b: Decimal) => (a.greaterThan(b) ? a : b);
