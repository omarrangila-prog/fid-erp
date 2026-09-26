import { prisma } from '@/lib/db';
import { dec, toMoney, type Decimal } from '@/lib/money';
import { getCommissionPaidByExpense } from '@/lib/services/agent-commission';
import { supplierGrossPayable } from '@/lib/services/tax';

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
 *   owed to an agent       settled by commission paid to that agent.
 *   owed to a supplier,    settled by posted payments allocated to it; a
 *   or to nobody yet       bounced or cancelled cheque settles nothing.
 *
 * What remains decides the status: nothing left is Paid, something paid but
 * not all is Partially paid, nothing paid is Unpaid. Whether a cost is paid
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
  PARTIAL: 'Partially paid',
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
  payableToAgentId: string | null;
  vendor?: { country: string | null } | null;
};

export async function getExpenseSettlements(
  companyId: string,
  expenses: SettlementInput[],
): Promise<Map<string, ExpenseSettlement>> {
  const posted = expenses.filter((e) => e.status === 'POSTED');
  const owedIds = posted.filter((e) => !e.cashBankAccountId && !e.payableToAgentId).map((e) => e.id);

  const [company, allocations, commission] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { country: true } }),
    owedIds.length
      ? prisma.$queryRaw<Array<{ expenseId: string; amount: string; accounts: string | null }>>`
          SELECT pa."expenseId",
                 COALESCE(SUM(pa."amount"), 0)::text AS amount,
                 string_agg(DISTINCT cba."name", ', ') AS accounts
          FROM payment_allocations pa
          JOIN payments p ON p."id" = pa."paymentId"
          LEFT JOIN cash_bank_accounts cba ON cba."id" = p."cashBankAccountId"
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
  const byExpense = new Map(allocations.map((a) => [a.expenseId, a]));

  const result = new Map<string, ExpenseSettlement>();
  for (const e of posted) {
    const localPerUnit = dec(e.amount).isZero() ? dec(0) : dec(e.amountLocal).dividedBy(dec(e.amount));
    let gross: Decimal;
    let paid: Decimal;
    let paidFrom: string | null = null;

    if (e.cashBankAccountId) {
      gross = toMoney(dec(e.amount).plus(dec(e.taxAmount)));
      paid = gross;
      paidFrom = e.cashBankAccount?.name ?? null;
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
    });
  }
  return result;
}

const Decimal_min = (a: Decimal, b: Decimal) => (a.lessThan(b) ? a : b);
const Decimal_max = (a: Decimal, b: Decimal) => (a.greaterThan(b) ? a : b);
