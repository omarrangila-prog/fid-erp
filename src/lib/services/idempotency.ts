import { transaction } from '@/lib/db';
import { writeAudit } from '@/lib/services/audit';

/**
 * One Save is one document, however many times it arrives.
 *
 * A double click, a browser retry after a slow network, or a form submitted a
 * second time from a stale tab would otherwise each create a receipt, a
 * payment or an expense — the same money recorded twice. Every such form now
 * carries a key issued once when it opens. The first request with that key
 * creates the document and records the key against it; any later request
 * with the same key gets the document already created instead of a new one.
 *
 * The key is held under a transaction-scoped advisory lock while the first
 * request works, so two requests racing with the same key cannot both miss
 * the record and both create: the second waits for the first to commit, then
 * finds its key.
 *
 * The record is an audit row (action SUBMISSION_KEY) rather than a new
 * column, so this needs no change to the live database; the audit screen
 * leaves these rows out.
 */
export const SUBMISSION_KEY_ACTION = 'SUBMISSION_KEY';

const KEY_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export async function onceForKey<T extends { id: string }>(
  params: { companyId: string; userId: string; scope: string; key?: string | null },
  create: () => Promise<T>,
): Promise<{ id: string; replayed: boolean; created: T | null }> {
  const key = params.key && KEY_PATTERN.test(params.key) ? params.key : null;
  if (!key) {
    const created = await create();
    return { id: created.id, replayed: false, created };
  }

  return transaction(async (tx) => {
    const lockName = `${params.companyId}:${params.scope}:${key}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockName}))`;

    const seen = await tx.auditLog.findFirst({
      where: {
        companyId: params.companyId,
        action: SUBMISSION_KEY_ACTION,
        entityType: params.scope,
        after: { path: ['key'], equals: key },
      },
      select: { entityId: true },
    });
    // A replay has nothing new to report beyond which document it was.
    if (seen) return { id: seen.entityId, replayed: true, created: null };

    const created = await create();
    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: SUBMISSION_KEY_ACTION,
      entityType: params.scope,
      entityId: created.id,
      after: { key },
    });
    return { id: created.id, replayed: false, created };
  }, 120_000);
}
