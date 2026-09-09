import { prisma, transaction } from '@/lib/db';
import { Decimal, dec, toMoney } from '@/lib/money';
import { BusinessRuleError, ConflictError, NotFoundError } from '@/lib/errors';
import { writeAudit } from '@/lib/services/audit';

/**
 * Bank reconciliation.
 *
 * Ticks ledger lines against a statement. The difference that matters is
 * Amounts are the account's own currency — the currency the statement is in —
 * not the company's books currency, which for a USD account in an AED company
 * is a different number entirely.
 *
 * The difference that matters is between the statement balance and the ledger
 * balance *after* allowing for
 * what has not yet cleared — a cheque written but not presented is a real
 * payment that the bank has not seen. The report shows all three figures so
 * the gap is explained rather than merely reported.
 *
 * Nothing here posts to the ledger: reconciling is an act of confirmation, not
 * of correction. A genuine error found while reconciling is fixed with a
 * journal voucher, which leaves a trail.
 */

export type ReconciliationLine = {
  journalLineId: string;
  entryDate: Date;
  entryNumber: string;
  description: string;
  /** What kind of document produced the line — a receipt, a payment, a cheque. */
  reference: string;
  /** Positive is money in, negative is money out, in the account's currency. */
  amount: Decimal;
  reconciled: boolean;
};

/** Ledger balance for an account up to a date, in the account's own currency. */
async function bookBalance(companyId: string, cashBankAccountId: string, upTo: Date): Promise<Decimal> {
  const rows = await prisma.$queryRaw<Array<{ bal: string }>>`
    SELECT COALESCE(SUM(jl."debit" - jl."credit"), 0)::text AS bal
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    WHERE je."companyId" = ${companyId}
      AND je."status" = 'POSTED'
      AND jl."cashBankAccountId" = ${cashBankAccountId}
      AND je."entryDate" <= ${upTo}::date`;

  const account = await prisma.cashBankAccount.findUniqueOrThrow({
    where: { id: cashBankAccountId },
    select: { openingBalance: true },
  });
  return toMoney(dec(rows[0]?.bal ?? 0).plus(account.openingBalance));
}

export async function getReconciliationWorkspace(params: {
  companyId: string;
  cashBankAccountId: string;
  statementDate: Date;
}) {
  const account = await prisma.cashBankAccount.findFirst({
    where: { id: params.cashBankAccountId, companyId: params.companyId },
    select: { id: true, name: true, code: true, currency: true },
  });
  if (!account) throw new NotFoundError('Cash or bank account');

  const existing = await prisma.bankReconciliation.findFirst({
    where: {
      companyId: params.companyId,
      cashBankAccountId: params.cashBankAccountId,
      statementDate: params.statementDate,
    },
  });

  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      entryDate: Date;
      entryNumber: string;
      description: string;
      reference: string;
      amount: string;
      reconciliationId: string | null;
    }>
  >`
    SELECT jl."id", je."entryDate", je."entryNumber",
           COALESCE(jl."description", je."description") AS description,
           je."sourceType"::text AS reference,
           (jl."debit" - jl."credit")::text AS amount,
           jl."bankReconciliationId" AS "reconciliationId"
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    WHERE je."companyId" = ${params.companyId}
      AND je."status" = 'POSTED'
      AND jl."cashBankAccountId" = ${params.cashBankAccountId}
      AND je."entryDate" <= ${params.statementDate}::date
      AND (jl."bankReconciliationId" IS NULL OR jl."bankReconciliationId" = ${existing?.id ?? null})
    ORDER BY je."entryDate" ASC, je."entryNumber" ASC`;

  const lines: ReconciliationLine[] = rows.map((row) => ({
    journalLineId: row.id,
    entryDate: row.entryDate,
    entryNumber: row.entryNumber,
    description: row.description,
    reference: row.reference,
    amount: toMoney(row.amount),
    reconciled: row.reconciliationId !== null,
  }));

  const book = await bookBalance(params.companyId, params.cashBankAccountId, params.statementDate);
  const clearedTotal = lines
    .filter((line) => line.reconciled)
    .reduce((sum, line) => sum.plus(line.amount), new Decimal(0));
  const outstanding = lines.filter((line) => !line.reconciled);

  const statementBalance = existing ? dec(existing.statementBalance) : new Decimal(0);
  // What the bank should show, given what has been ticked.
  const reconciledBalance = toMoney(clearedTotal);
  const difference = toMoney(statementBalance.minus(reconciledBalance));

  return {
    account,
    reconciliation: existing,
    lines,
    bookBalance: book,
    reconciledBalance,
    statementBalance,
    difference,
    unclearedDeposits: toMoney(
      outstanding.filter((l) => l.amount.greaterThan(0)).reduce((s, l) => s.plus(l.amount), new Decimal(0)),
    ),
    unclearedPayments: toMoney(
      outstanding.filter((l) => l.amount.lessThan(0)).reduce((s, l) => s.plus(l.amount.abs()), new Decimal(0)),
    ),
  };
}

export async function openReconciliation(
  input: { companyId: string; cashBankAccountId: string; statementDate: Date; statementBalance: string | number },
  userId: string,
) {
  return transaction(async (tx) => {
    const account = await tx.cashBankAccount.findFirst({
      where: { id: input.cashBankAccountId, companyId: input.companyId },
      select: { id: true, name: true },
    });
    if (!account) throw new NotFoundError('Cash or bank account');

    const existing = await tx.bankReconciliation.findFirst({
      where: {
        companyId: input.companyId,
        cashBankAccountId: input.cashBankAccountId,
        statementDate: input.statementDate,
      },
    });
    if (existing?.isComplete) {
      throw new ConflictError('That statement date has already been reconciled and signed off.');
    }
    if (existing) {
      return tx.bankReconciliation.update({
        where: { id: existing.id },
        data: { statementBalance: dec(input.statementBalance) },
      });
    }

    const created = await tx.bankReconciliation.create({
      data: {
        companyId: input.companyId,
        cashBankAccountId: input.cashBankAccountId,
        statementDate: input.statementDate,
        statementBalance: dec(input.statementBalance),
        createdById: userId,
      },
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId,
      action: 'RECONCILIATION_OPENED',
      entityType: 'BankReconciliation',
      entityId: created.id,
      after: { account: account.name, statementBalance: String(input.statementBalance) },
    });

    return created;
  });
}

/** Ticks or unticks one ledger line against the statement. */
export async function setLineReconciled(params: {
  companyId: string;
  reconciliationId: string;
  journalLineId: string;
  reconciled: boolean;
}) {
  return transaction(async (tx) => {
    const reconciliation = await tx.bankReconciliation.findFirst({
      where: { id: params.reconciliationId, companyId: params.companyId },
    });
    if (!reconciliation) throw new NotFoundError('Reconciliation');
    if (reconciliation.isComplete) {
      throw new BusinessRuleError('This reconciliation has been signed off and can no longer be changed.');
    }

    await tx.journalLine.update({
      where: { id: params.journalLineId },
      data: { bankReconciliationId: params.reconciled ? reconciliation.id : null },
    });

    return { ok: true };
  });
}

export async function completeReconciliation(params: { id: string; companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const reconciliation = await tx.bankReconciliation.findFirst({
      where: { id: params.id, companyId: params.companyId },
    });
    if (!reconciliation) throw new NotFoundError('Reconciliation');
    if (reconciliation.isComplete) {
      throw new ConflictError('This reconciliation is already signed off.');
    }

    const workspace = await getReconciliationWorkspace({
      companyId: params.companyId,
      cashBankAccountId: reconciliation.cashBankAccountId,
      statementDate: reconciliation.statementDate,
    });

    if (!workspace.difference.isZero()) {
      throw new BusinessRuleError(
        `The statement and the ticked lines differ by ${workspace.difference.toFixed(2)}. Reconcile to zero before signing off — an unexplained difference is the whole point of doing this.`,
      );
    }

    const completed = await tx.bankReconciliation.update({
      where: { id: reconciliation.id },
      data: {
        isComplete: true,
        completedAt: new Date(),
        bookBalance: workspace.bookBalance,
        difference: 0,
      },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'RECONCILIATION_COMPLETED',
      entityType: 'BankReconciliation',
      entityId: reconciliation.id,
      after: { statementBalance: reconciliation.statementBalance.toString() },
    });

    return completed;
  });
}
