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
      select: { id: true, payableToAgentId: true, amountUsd: true },
    }),
    prisma.agentSettlement.findMany({
      where: { companyId, direction: 'COMMISSION', status: 'POSTED' },
      orderBy: [{ settlementDate: 'asc' }, { createdAt: 'asc' }],
      select: { agentId: true, amountUsd: true },
    }),
  ]);

  const pool = new Map<string, Decimal>();
  for (const settlement of settlements) {
    pool.set(settlement.agentId, (pool.get(settlement.agentId) ?? new Decimal(0)).plus(settlement.amountUsd));
  }

  const paid = new Map<string, Decimal>();
  for (const expense of expenses) {
    const agentId = expense.payableToAgentId;
    if (!agentId) {
      paid.set(expense.id, new Decimal(0));
      continue;
    }
    const available = pool.get(agentId) ?? new Decimal(0);
    const amountUsd = dec(expense.amountUsd);
    const applied = available.lessThan(amountUsd) ? available : amountUsd;
    paid.set(expense.id, toMoney(applied));
    pool.set(agentId, toMoney(available.minus(applied)));
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
      containerNumber: expense.container?.containerNumber ?? null,
      batchNumber: expense.batch?.batchNumber ?? null,
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
