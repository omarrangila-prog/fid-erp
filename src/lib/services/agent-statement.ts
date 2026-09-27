import { prisma } from '@/lib/db';
import { dec, toMoney, type Decimal } from '@/lib/money';
import { getAgentLedger, type AgentLedgerRow, type AgentLedgerSummary } from '@/lib/services/agent-account';
import { getExpenseSettlements } from '@/lib/services/expense-settlement';
import { journalSourceHref } from '@/lib/journal-source';
import { businessNumber } from '@/lib/short-number';
import type { LedgerDocument } from '@/lib/services/ledger-sql';

/**
 * One agent's relationship statement: every business event between FID and
 * the agent, one line each, oldest first.
 *
 * The books keep his balances apart — Agent Clearing (customer money he
 * holds), Agent Commission Payable, "Loan from" and "Loan to" accounts, and
 * what he owes for coffee he bought himself — and they stay apart. This reads
 * the lines those accounts carry under his name (his agent id, never a
 * search of memo text) and gathers them back into the events that wrote them:
 * a commission set off against his collections is one line that lowers what
 * FID owes him and what he owes FID, not two lines that look like two
 * payments. Each line says how it moved each side, and a running position
 * says where the two sides stand together. The position is a view only;
 * nothing is set against anything by reading it.
 */

export type AgentEventFilter =
  | 'ALL'
  | 'COLLECTIONS'
  | 'COMMISSION'
  | 'LOANS'
  | 'SETTLEMENTS'
  | 'SHIPMENTS'
  | 'JOURNALS'
  | 'UNPAID_EXPENSES'
  | 'SET_OFFS';

export const AGENT_EVENT_FILTERS: Record<AgentEventFilter, string> = {
  ALL: 'All activity',
  COLLECTIONS: 'Collections',
  COMMISSION: 'Commission',
  LOANS: 'Loans',
  SETTLEMENTS: 'Settlements',
  SHIPMENTS: 'Shipment transactions',
  JOURNALS: 'Journal entries',
  UNPAID_EXPENSES: 'Unpaid expenses',
  SET_OFFS: 'Set-offs',
};

export function isAgentEventFilter(value: string | undefined): value is AgentEventFilter {
  return !!value && value in AGENT_EVENT_FILTERS;
}

export type AgentLedgerEvent = {
  journalEntryId: string;
  /** The journal it wrote, e.g. JV 109. */
  journalNumber: string;
  /** The business document, e.g. EXP 21 or PAY 22; null for a journal voucher. */
  documentNumber: string | null;
  date: Date;
  sourceType: string;
  sourceHref: string | null;
  typeLabel: string;
  filters: AgentEventFilter[];
  shipment: { id: string; reference: string } | null;
  customerName: string | null;
  documents: LedgerDocument[];
  memo: string | null;
  /** The amount in the currency it was entered in. */
  currency: string;
  amount: Decimal;
  amountLocal: Decimal;
  /** How the event moved what the agent owes FID (+ more, − less), in the company's currency. */
  receivableChangeLocal: Decimal;
  /** How it moved what FID owes the agent (+ more, − less). */
  payableChangeLocal: Decimal;
  /** Where the two stand together after it: positive, the agent owes FID. */
  runningNetLocal: Decimal;
  status: string;
  createdBy: string | null;
  /** The accounting behind it, for the detail view. */
  lines: AgentLedgerRow[];
};

export type AgentStatement = {
  events: AgentLedgerEvent[];
  summary: AgentLedgerSummary & {
    /** Everything the agent owes FID: collections held, loans to him, his own purchases, other. */
    owesFidLocal: Decimal;
    /** Everything FID owes the agent: commission and loans from him. */
    fidOwesLocal: Decimal;
    /** Of what FID owes him, the costs booked as owed to him and not yet settled. */
    unpaidExpensesLocal: Decimal;
  };
  shipments: Array<{ id: string; reference: string }>;
};

const RECEIVABLE_KINDS = new Set(['Agent Clearing', 'Loan to agent', 'Trade receivable', 'Other']);

export async function getAgentStatement(params: { companyId: string; agentId: string }): Promise<AgentStatement> {
  const [{ rows, summary }, agent] = await Promise.all([
    getAgentLedger({ companyId: params.companyId, agentId: params.agentId }),
    prisma.agent.findFirstOrThrow({ where: { id: params.agentId, companyId: params.companyId }, select: { agentName: true } }),
  ]);
  const name = agent.agentName;

  // One group per journal entry, in the order the lines came.
  const groups: AgentLedgerRow[][] = [];
  const byEntry = new Map<string, AgentLedgerRow[]>();
  for (const row of rows) {
    let group = byEntry.get(row.journalEntryId);
    if (!group) {
      group = [];
      byEntry.set(row.journalEntryId, group);
      groups.push(group);
    }
    group.push(row);
  }

  // What the documents behind the events say, so each event reads in the client's words.
  const idsOf = (type: string) => [...new Set(groups.filter((g) => g[0].sourceType === type).map((g) => g[0].sourceId))];
  const [expenses, settlements, payments] = await Promise.all([
    idsOf('EXPENSE').length
      ? prisma.expense.findMany({
          where: { companyId: params.companyId, id: { in: idsOf('EXPENSE') } },
          include: {
            expenseCategory: { select: { name: true } },
            cashBankAccount: { select: { name: true } },
            vendor: { select: { country: true } },
            shipment: { select: { id: true, purchaseContract: { select: { contractReference: true } } } },
          },
        })
      : Promise.resolve([]),
    idsOf('AGENT_SETTLEMENT').length
      ? prisma.agentSettlement.findMany({
          where: { companyId: params.companyId, id: { in: idsOf('AGENT_SETTLEMENT') } },
          select: {
            id: true,
            settlementNumber: true,
            direction: true,
            notes: true,
            cashBankAccount: { select: { name: true, accountType: true } },
            expense: {
              select: {
                expenseNumber: true,
                expenseCategory: { select: { name: true } },
                shipment: { select: { id: true, purchaseContract: { select: { contractReference: true } } } },
              },
            },
          },
        })
      : Promise.resolve([]),
    idsOf('PAYMENT').length
      ? prisma.payment.findMany({
          where: { companyId: params.companyId, id: { in: idsOf('PAYMENT') } },
          select: {
            id: true,
            paymentNumber: true,
            ledgerAgentId: true,
            allocations: {
              select: {
                expense: {
                  select: {
                    expenseNumber: true,
                    expenseCategory: { select: { name: true } },
                    shipment: { select: { id: true, purchaseContract: { select: { contractReference: true } } } },
                  },
                },
              },
            },
          },
        })
      : Promise.resolve([]),
  ]);
  const expenseById = new Map(expenses.map((e) => [e.id, e]));
  const settlementById = new Map(settlements.map((s) => [s.id, s]));
  const paymentById = new Map(payments.map((p) => [p.id, p]));
  const expenseStatus = expenses.length ? await getExpenseSettlements(params.companyId, expenses) : new Map();

  let running = dec(0);
  const events: AgentLedgerEvent[] = groups.map((lines) => {
    const first = lines[0];
    let receivable = dec(0);
    let payable = dec(0);
    for (const line of lines) {
      const movement = line.debitLocal.minus(line.creditLocal);
      if (RECEIVABLE_KINDS.has(line.accountKind)) receivable = receivable.plus(movement);
      else payable = payable.minus(movement);
    }
    receivable = toMoney(receivable);
    payable = toMoney(payable);
    running = toMoney(running.plus(receivable).minus(payable));

    // The line that says most about the event names its amount and currency.
    const principal = lines.reduce((a, b) =>
      b.debitLocal.plus(b.creditLocal).greaterThan(a.debitLocal.plus(a.creditLocal)) ? b : a,
    );
    const has = (kind: AgentLedgerRow['accountKind'], side?: 'debit' | 'credit') =>
      lines.some(
        (l) =>
          l.accountKind === kind &&
          (!side || (side === 'debit' ? l.debitLocal.greaterThan(0) : l.creditLocal.greaterThan(0))),
      );
    const filters = new Set<AgentEventFilter>(['ALL']);
    let typeLabel = first.typeLabel;
    let documentNumber: string | null = first.reference ? businessNumber(first.reference) : null;
    let status = first.status;
    const shipLine = lines.find((l) => l.shipmentId && l.shipmentReference);
    let shipment: AgentLedgerEvent['shipment'] = shipLine
      ? { id: shipLine.shipmentId!, reference: shipLine.shipmentReference! }
      : null;
    let memo = first.memo;

    const source = first.sourceType;
    if (source === 'RECEIPT' && has('Agent Clearing', 'debit')) {
      typeLabel = first.status && first.status !== 'Posted' ? 'Customer Cheque Collection' : 'Customer Collection';
      filters.add('COLLECTIONS');
    } else if (source === 'EXPENSE') {
      const expense = expenseById.get(first.sourceId);
      documentNumber = expense ? businessNumber(expense.expenseNumber) : documentNumber;
      memo = expense?.description ?? memo;
      if (expense?.shipment) shipment = { id: expense.shipment.id, reference: expense.shipment.purchaseContract.contractReference };
      if (has('Commission', 'credit')) {
        typeLabel = expense?.expenseCategory.name ?? 'Agent Commission';
        const s = expenseStatus.get(first.sourceId);
        status = s ? (s.status === 'PAID' ? 'Settled' : s.status === 'PARTIAL' ? 'Partially settled' : 'Unpaid') : 'Unpaid';
        filters.add('COMMISSION').add('UNPAID_EXPENSES');
      } else if (has('Agent Clearing', 'credit')) {
        typeLabel = `${expense?.expenseCategory.name ?? 'Cost'} — paid from his collections`;
        filters.add('SET_OFFS');
      }
    } else if (source === 'AGENT_SETTLEMENT') {
      const s = settlementById.get(first.sourceId);
      documentNumber = s ? businessNumber(s.settlementNumber) : documentNumber;
      memo = s?.notes ?? memo;
      const how = s?.cashBankAccount ? (s.cashBankAccount.accountType === 'BANK' ? 'Bank' : 'Cash') : null;
      if (s?.expense?.shipment) {
        shipment = { id: s.expense.shipment.id, reference: s.expense.shipment.purchaseContract.contractReference };
      }
      if (s?.direction === 'COMMISSION_OFFSET') {
        typeLabel = 'Commission set-off against Agent Clearing';
        filters.add('SET_OFFS').add('COMMISSION').add('SETTLEMENTS');
      } else if (s?.direction === 'COMMISSION') {
        typeLabel = `Commission settlement${how ? ` — ${how}` : ''}`;
        filters.add('COMMISSION').add('SETTLEMENTS');
      } else if (s?.direction === 'COLLECTION') {
        typeLabel = `Agent settlement — money handed over${how ? ` (${how})` : ''}`;
        filters.add('SETTLEMENTS').add('COLLECTIONS');
      } else {
        filters.add('SETTLEMENTS');
      }
    } else if (source === 'PAYMENT') {
      const p = paymentById.get(first.sourceId);
      documentNumber = p ? businessNumber(p.paymentNumber) : documentNumber;
      const settled = p?.allocations.map((a) => a.expense).find(Boolean);
      if (settled?.shipment) shipment = { id: settled.shipment.id, reference: settled.shipment.purchaseContract.contractReference };
      if (p?.ledgerAgentId && has('Agent Clearing', 'credit')) {
        typeLabel = `Set-off against Agent Clearing${settled ? ` — ${settled.expenseCategory.name}` : ''}`;
        filters.add('SET_OFFS').add('SETTLEMENTS');
      } else {
        filters.add('SETTLEMENTS');
      }
    } else if (source === 'SALES_INVOICE') {
      typeLabel = `Direct sale to ${name}`;
    } else if (source === 'MANUAL') {
      filters.add('JOURNALS');
      documentNumber = null;
      if (has('Loan from agent', 'credit')) typeLabel = `Loan received from ${name}`;
      else if (has('Loan from agent', 'debit')) typeLabel = `Loan repaid to ${name}`;
      else if (has('Loan to agent', 'debit')) typeLabel = `Loan given to ${name}`;
      else if (has('Loan to agent', 'credit')) typeLabel = `Loan repaid by ${name}`;
      else if (has('Agent Clearing')) typeLabel = 'Journal — Agent Clearing';
      else typeLabel = 'Journal entry';
    }
    if (has('Loan from agent') || has('Loan to agent')) filters.add('LOANS');
    if (has('Commission')) filters.add('COMMISSION');
    if (shipment) filters.add('SHIPMENTS');

    return {
      journalEntryId: first.journalEntryId,
      journalNumber: businessNumber(first.entryNumber),
      documentNumber: documentNumber && documentNumber !== businessNumber(first.entryNumber) ? documentNumber : null,
      date: first.entryDate,
      sourceType: source,
      sourceHref: journalSourceHref(source, first.sourceId, { entryNumber: first.entryNumber }),
      typeLabel,
      filters: [...filters],
      shipment,
      customerName: lines.find((l) => l.customerName)?.customerName ?? null,
      documents: lines.flatMap((l) => l.documents).filter((d, i, all) => all.findIndex((x) => x.id === d.id) === i),
      memo,
      currency: principal.currency,
      amount: toMoney(principal.debit.plus(principal.credit)),
      amountLocal: toMoney(principal.debitLocal.plus(principal.creditLocal)),
      receivableChangeLocal: receivable,
      payableChangeLocal: payable,
      runningNetLocal: running,
      status,
      createdBy: first.createdBy,
      lines,
    };
  });

  const unpaidExpensesLocal = toMoney(
    [...expenseStatus.values()].reduce((t: Decimal, s: { outstandingLocal: Decimal }) => t.plus(s.outstandingLocal), dec(0)),
  );
  const owesFid = toMoney(summary.holdingLocal.plus(summary.loanToAgentLocal).plus(summary.tradeReceivableLocal).plus(summary.otherLocal));
  const fidOwes = toMoney(summary.commissionLocal.plus(summary.loanFromAgentLocal));
  const shipments = [...new Map(events.filter((e) => e.shipment).map((e) => [e.shipment!.id, e.shipment!])).values()];

  return {
    events,
    summary: { ...summary, owesFidLocal: owesFid, fidOwesLocal: fidOwes, unpaidExpensesLocal },
    shipments,
  };
}

