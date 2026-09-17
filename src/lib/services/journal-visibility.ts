import { Prisma } from '@prisma/client';

/**
 * Which journal entries a person sees.
 *
 * A document that was taken back after posting leaves two entries in the
 * books: the original, and a mirror that undoes it line for line. Both stay
 * POSTED, because that pair is what keeps the ledger whole and the audit log
 * honest. But to the person running the business the document was deleted,
 * and a ledger that lists a sale and then its undoing is a ledger that has to
 * be explained every time it is read.
 *
 * So every ledger, register and report shows only entries that count: posted,
 * not a mirror, and not something a mirror has undone. The pair nets to zero,
 * so no total moves. The reconciliation deliberately does not use this — its
 * job is to check the raw books, mirrors included.
 *
 * Two spellings of the same rule, because the reports use tagged templates
 * and the ledgers build their SQL as strings. The alias `je` is assumed.
 */
export const LIVE_ENTRY_SQL = Prisma.sql`je."status" = 'POSTED' AND je."isReversal" = false AND NOT EXISTS (SELECT 1 FROM journal_entries rv WHERE rv."reversalOfId" = je."id")`;

export const LIVE_ENTRY_TEXT = `je."status" = 'POSTED' AND je."isReversal" = false AND NOT EXISTS (SELECT 1 FROM journal_entries rv WHERE rv."reversalOfId" = je."id")`;

/** The same rule for a Prisma `where`. */
export const LIVE_ENTRY_WHERE = {
  status: 'POSTED' as const,
  isReversal: false,
  reversedBy: { is: null },
};
