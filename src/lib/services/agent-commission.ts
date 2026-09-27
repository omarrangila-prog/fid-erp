import { prisma } from '@/lib/db';
import { Decimal, dec, toMoney } from '@/lib/money';

/**
 * Agent commission register.
 *
 * Commission is booked as an unpaid shipment expense the day it is agreed.
 * Paying the agent later is a settlement against the agent's payable, not a
 * line on the original voucher — so this register reconstructs Unpaid /
 * Partially Paid / Paid by applying posted commission settlements FIFO to the
 * expenses of that agent.
 */

export type CommissionStatus = 'UNPAID' | 'PARTIAL' | 'PAID';

export type AgentCommissionRow = {
  expenseId: string;
  expenseNumber: string;
  expenseDate: Date;
  agentId: string;
  agentName: string;
  contractId: string | null;
  contractReference: string | null;
  shipmentId: string | null;
  jobNumber: string | null;
  containerNumber: string | null;
  batchNumber: string | null;
  currency: string;
  amount: Decimal;
  amountUsd: Decimal;
  rateToUsd: Decimal;
  paidUsd: Decimal;
  remainingUsd: Decimal;
  status: CommissionStatus;
};

function statusFor(amountUsd: Decimal, paidUsd: Decimal): CommissionStatus {
  if (paidUsd.greaterThanOrEqualTo(amountUsd.minus('0.01'))) return 'PAID';
  if (paidUsd.greaterThan('0.01')) return 'PARTIAL';
  return 'UNPAID';
}

/** How much of each commission expense has been settled, FIFO per agent. */
export async function getCommissionPaidByExpense(companyId: string): Promise<Map<string, Decimal>> {
  const [expenses, settlements] = await Promise.all([
    prisma.expense.findMany({
      where: { companyId, status: 'POSTED', payableToAgentId: { not: null } },
      orderBy: [{ expenseDate: 'asc' }, { createdAt: 'asc' }, { expenseNumber: 'asc' }],
      select: { id: true, payableToAgentId: true, amountUsd: true, amountLocal: true },
    }),
    /*
     * Paid in cash or bank, or settled against the customer money he holds:
     * both settle the commission. Counted in the company's own currency, so a
     * dirham commission settled in dirhams reads settled in full whatever the
     * dollar rate did in between.
     */
    prisma.agentSettlement.findMany({
      where: { companyId, direction: { in: ['COMMISSION', 'COMMISSION_OFFSET'] }, status: 'POSTED' },
      orderBy: [{ settlementDate: 'asc' }, { createdAt: 'asc' }],
      select: { agentId: true, amountLocal: true, expenseId: true },
    }),
  ]);

  /*
   * A settlement made from the cost itself names that cost and settles it
   * first; what it names is exactly what it paid. Anything else — a
   * commission paid from the agent's page — goes to his oldest costs, as
   * before.
   */
  const owedById = new Map(expenses.map((e) => [e.id, dec(e.amountLocal)]));
  const linked = new Map<string, Decimal>();
  const pool = new Map<string, Decimal>();
  for (const settlement of settlements) {
    const owed = settlement.expenseId ? owedById.get(settlement.expenseId) : undefined;
    if (settlement.expenseId && owed) {
      const already = linked.get(settlement.expenseId) ?? new Decimal(0);
      const room = Decimal.max(owed.minus(already), new Decimal(0));
      const applied = Decimal.min(room, dec(settlement.amountLocal));
      linked.set(settlement.expenseId, already.plus(applied));
      const rest = dec(settlement.amountLocal).minus(applied);
      if (rest.greaterThan(0)) pool.set(settlement.agentId, (pool.get(settlement.agentId) ?? new Decimal(0)).plus(rest));
      continue;
    }
    pool.set(settlement.agentId, (pool.get(settlement.agentId) ?? new Decimal(0)).plus(settlement.amountLocal));
  }

  // What is settled, returned in USD as before, as the share of each cost
  // that the settlements in the company's currency cover.
  const paid = new Map<string, Decimal>();
  for (const expense of expenses) {
    const agentId = expense.payableToAgentId;
    if (!agentId) {
      paid.set(expense.id, new Decimal(0));
      continue;
    }
    const available = pool.get(agentId) ?? new Decimal(0);
    const settledHere = linked.get(expense.id) ?? new Decimal(0);
    const owedLocal = dec(expense.amountLocal);
    const stillOwed = Decimal.max(owedLocal.minus(settledHere), new Decimal(0));
    const fromPool = available.lessThan(stillOwed) ? available : stillOwed;
    pool.set(agentId, toMoney(available.minus(fromPool)));
    const appliedLocal = settledHere.plus(fromPool);
    paid.set(
      expense.id,
      owedLocal.isZero() ? new Decimal(0) : toMoney(dec(expense.amountUsd).times(appliedLocal).dividedBy(owedLocal)),
    );
  }

  return paid;
}

export async function getAgentCommissionRegister(companyId: string): Promise<AgentCommissionRow[]> {
  const expenses = await prisma.expense.findMany({
    where: { companyId, status: 'POSTED', payableToAgentId: { not: null } },
    orderBy: [{ expenseDate: 'desc' }, { expenseNumber: 'desc' }],
    include: {
      payableToAgent: { select: { id: true, agentName: true } },
      purchaseContract: { select: { id: true, contractReference: true, contractNumber: true } },
      shipment: {
        select: {
          id: true,
          jobNumber: true,
          purchaseContract: { select: { id: true, contractReference: true, contractNumber: true } },
        },
      },
      container: { select: { containerNumber: true } },
      batch: { select: { batchNumber: true } },
    },
  });

  const paidByExpense = await getCommissionPaidByExpense(companyId);

  return expenses.map((expense) => {
    const amountUsd = toMoney(expense.amountUsd);
    const paidUsd = toMoney(paidByExpense.get(expense.id) ?? 0);
    const remainingUsd = toMoney(amountUsd.minus(paidUsd));
    const contract = expense.purchaseContract ?? expense.shipment?.purchaseContract ?? null;

    return {
      expenseId: expense.id,
      expenseNumber: expense.expenseNumber,
      expenseDate: expense.expenseDate,
      agentId: expense.payableToAgent!.id,
      agentName: expense.payableToAgent!.agentName,
      contractId: contract?.id ?? null,
      contractReference: contract?.contractReference ?? contract?.contractNumber ?? null,
      shipmentId: expense.shipment?.id ?? null,
      jobNumber: expense.shipment?.jobNumber ?? null,
      containerNumber: 'container' in expense ? (expense.container?.containerNumber ?? null) : null,
      batchNumber: 'batch' in expense ? (expense.batch?.batchNumber ?? null) : null,
      currency: expense.currency,
      amount: toMoney(expense.amount),
      amountUsd,
      rateToUsd: dec(expense.rateToUsd),
      paidUsd,
      remainingUsd,
      status: statusFor(amountUsd, paidUsd),
    };
  });
}
