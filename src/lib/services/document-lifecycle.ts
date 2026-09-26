import { prisma, transaction } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { reverseJournalEntry } from '@/lib/services/accounting';
import { writeAudit } from '@/lib/services/audit';
import { reverseReceiptIn } from '@/lib/services/receipt';
import { reversePayment } from '@/lib/services/payment';
import { reverseExpense } from '@/lib/services/expense';
import { reverseSalesInvoice } from '@/lib/services/sales';
import { reverseCreditNote } from '@/lib/services/credit-note';
import { reversePurchaseContract } from '@/lib/services/purchase';
import { cancelStockCount } from '@/lib/services/stock-count';

/**
 * Delete anything that has been posted, from wherever it is being read.
 *
 * Until now a posted voucher could only be taken back out of the books from
 * the screen that created it, and several kinds — a journal voucher, a loan,
 * a transfer between accounts, a revaluation, an agent's settlement — had no
 * way at all. The client's complaint is exactly that: some rows can be
 * deleted and some cannot, and there is no telling which from looking.
 *
 * So: every posted entry can be deleted, from the journal, from a ledger,
 * from the document itself. What "delete" means is the same everywhere — the
 * entry is reversed, the document is marked as deleted, and both disappear
 * from every list, ledger, report and total.
 *
 * What it does not mean is that the rows are erased. A posting that has been
 * in the books cannot be taken out of them without leaving the trial balance
 * unable to prove itself, and an auditor asking what happened to a document
 * deserves an answer better than silence. The reversal is that answer, and
 * it costs the client nothing: what they asked for is that the thing stops
 * appearing, and it does.
 *
 * Where the entry belongs to a document with its own consequences — stock
 * moved, invoices settled, a cheque issued, landed cost on a batch — the
 * document's own reversal runs, because only it knows how to undo those.
 * Everything else is a journal entry and is mirrored directly.
 */

/**
 * Take one posted entry back out of the books.
 *
 * `entryId` names the exact entry, so a document corrected three times can
 * have the right one reversed rather than whichever was posted last.
 */
export async function deletePostedEntry(params: {
  companyId: string;
  userId: string;
  entryId: string;
  reason: string;
}) {
  if (!params.reason?.trim()) {
    throw new BusinessRuleError('Say why this is being deleted. It goes on the audit trail.');
  }

  const entry = await prisma.journalEntry.findFirst({
    where: { id: params.entryId, companyId: params.companyId },
    select: {
      id: true,
      entryNumber: true,
      sourceType: true,
      sourceId: true,
      status: true,
      isReversal: true,
      reversedBy: { select: { id: true } },
    },
  });
  if (!entry) throw new NotFoundError('Journal entry');
  if (entry.status !== 'POSTED') {
    throw new BusinessRuleError('This entry is not posted, so there is nothing in the books to take out.');
  }
  if (entry.isReversal) {
    throw new BusinessRuleError(
      'This entry is itself the reversal of something else. Deleting it would put back what it took out.',
    );
  }
  if (entry.reversedBy) {
    throw new BusinessRuleError('This entry has already been deleted.');
  }
  // The system's own correction that keeps stock, cost of sales and the
  // batches in step after a price or cost changed. On its own, taking it out
  // would put them out of step again.
  if (entry.sourceType === 'LANDED_COST') {
    throw new BusinessRuleError(
      'This entry keeps the stock value in step with a corrected price or cost. Correct the purchase order or the expense instead, and it follows.',
    );
  }

  const common = { companyId: params.companyId, userId: params.userId, reason: params.reason.trim() };

  /*
   * A document that did more than post a journal is undone by its own code,
   * which knows what else has to come back: the stock, the allocations, the
   * cheque, the landed cost on a batch.
   */
  switch (entry.sourceType) {
    case 'RECEIPT':
      await transaction((tx) => reverseReceiptIn(tx, { id: entry.sourceId, ...common }));
      return entry;
    case 'PAYMENT':
      await reversePayment({ id: entry.sourceId, ...common });
      return entry;
    case 'EXPENSE':
      await reverseExpense({ id: entry.sourceId, ...common });
      return entry;
    case 'SALES_INVOICE':
      await reverseSalesInvoice({ id: entry.sourceId, ...common });
      return entry;
    case 'CREDIT_NOTE':
      await reverseCreditNote({ id: entry.sourceId, ...common });
      return entry;
    case 'PURCHASE_CONTRACT':
      await reversePurchaseContract({ id: entry.sourceId, ...common });
      return entry;
    case 'STOCK_COUNT':
      await cancelStockCount({ id: entry.sourceId, ...common });
      return entry;
    default:
      break;
  }

  /*
   * Everything else — a journal voucher, a loan, money moved between the
   * company's own accounts, a revaluation, an agent's settlement — is the
   * journal entry and nothing besides, so mirroring it is the whole job.
   */
  return transaction(async (tx) => {
    const reversal = await reverseJournalEntry(tx, {
      companyId: params.companyId,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      entryId: entry.id,
      createdById: params.userId,
      entryDate: new Date(),
      reason: params.reason.trim(),
    });

    // A settlement has a document of its own to mark, even though its only
    // effect on the books was the entry just mirrored.
    if (entry.sourceType === 'AGENT_SETTLEMENT') {
      await tx.agentSettlement
        .updateMany({
          where: { id: entry.sourceId, companyId: params.companyId },
          data: { status: 'REVERSED' },
        })
        .catch(() => undefined);
    }

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'JOURNAL_ENTRY_DELETED',
      entityType: 'JournalEntry',
      entityId: entry.id,
      before: { entryNumber: entry.entryNumber, sourceType: entry.sourceType },
      after: { reversedBy: reversal.entryNumber, reason: params.reason.trim() },
    });

    return entry;
  });
}
