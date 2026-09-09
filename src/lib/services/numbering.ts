import { randomUUID } from 'node:crypto';
import type { Tx } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';

/**
 * Concurrency-safe document numbering.
 *
 * Numbers carry the company prefix so a document is identifiable on sight:
 *
 *   FID-DXB-PO-000001   Dubai purchase contract
 *   FID-MA-SI-000042    Morocco sales invoice
 *
 * The counter is advanced with a single `INSERT ... ON CONFLICT DO UPDATE ...
 * RETURNING`. Postgres holds a row lock for the duration of that statement, so
 * two simultaneous posts can never be handed the same number — no
 * application-level locking required.
 */

const SEQUENCE_YEAR = 0; // Numbering runs continuously rather than per year.

export async function nextReference(
  tx: Tx,
  params: { companyId: string; docType: string; prefixOverride?: string },
): Promise<string> {
  const { companyId, docType } = params;

  let prefix = params.prefixOverride;
  if (!prefix) {
    const company = await tx.company.findUnique({
      where: { id: companyId },
      select: { docPrefix: true },
    });
    if (!company) throw new NotFoundError('Company');
    prefix = company.docPrefix;
  }

  const rows = await tx.$queryRaw<Array<{ lastNumber: number; prefix: string }>>`
    INSERT INTO number_sequences ("id", "companyId", "docType", "year", "prefix", "lastNumber", "updatedAt")
    VALUES (${randomUUID()}, ${companyId}, ${docType}, ${SEQUENCE_YEAR}, ${prefix}, 1, now())
    ON CONFLICT ("companyId", "docType", "year")
    DO UPDATE SET "lastNumber" = number_sequences."lastNumber" + 1, "updatedAt" = now()
    RETURNING "lastNumber", "prefix"
  `;

  const row = rows[0];
  if (!row) throw new Error(`Failed to allocate a document number for ${docType}.`);

  return `${row.prefix}-${docType}-${String(row.lastNumber).padStart(6, '0')}`;
}
