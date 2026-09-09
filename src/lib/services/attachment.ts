import 'server-only';
import { createHash } from 'node:crypto';
import { prisma, transaction } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { writeAudit } from '@/lib/services/audit';

/**
 * Document attachments: the bill of lading, the supplier's invoice, a quality
 * certificate, the signed delivery note.
 *
 * Files live in the database rather than on disk. The application runs on a
 * serverless host, where the filesystem is read-only and each request gets a
 * container that is discarded afterwards — a file written during an upload
 * would simply not be there when somebody tried to download it. Keeping the
 * bytes in Postgres also means every attachment is inside the database backup,
 * instead of being a second thing to remember to copy.
 *
 * The cost is database size, which is why the per-file cap is deliberate. If
 * the business ever outgrows it, only the four functions below change.
 */

const MAX_BYTES = Number(process.env.ATTACHMENT_MAX_BYTES ?? 20 * 1024 * 1024);

/** Types a trading business actually attaches. Anything else is refused. */
const ALLOWED = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

export function isAllowedType(mimeType: string): boolean {
  return ALLOWED.has(mimeType);
}

/** Everything except the bytes, which are never wanted in a listing. */
const LIST_FIELDS = {
  id: true,
  companyId: true,
  entityType: true,
  entityId: true,
  category: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  checksum: true,
  createdAt: true,
  uploadedBy: { select: { name: true } },
} as const;

export async function saveAttachment(input: {
  companyId: string;
  entityType: string;
  entityId: string;
  category?: string | null;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  uploadedById: string;
}) {
  if (!isAllowedType(input.mimeType)) {
    throw new BusinessRuleError(
      `Files of type ${input.mimeType || 'unknown'} are not accepted. Attach a PDF, an image, a spreadsheet or a document.`,
    );
  }
  if (input.bytes.byteLength === 0) {
    throw new BusinessRuleError('That file is empty.');
  }
  if (input.bytes.byteLength > MAX_BYTES) {
    throw new BusinessRuleError(
      `That file is ${(input.bytes.byteLength / 1024 / 1024).toFixed(1)} MB. The limit is ${(MAX_BYTES / 1024 / 1024).toFixed(0)} MB.`,
    );
  }

  return transaction(async (tx) => {
    const attachment = await tx.attachment.create({
      data: {
        companyId: input.companyId,
        entityType: input.entityType,
        entityId: input.entityId,
        category: input.category ?? null,
        // The name is display only and never becomes a path, so a filename
        // like "../../etc/passwd" is just an odd-looking label.
        fileName: input.fileName.slice(0, 200),
        mimeType: input.mimeType,
        sizeBytes: input.bytes.byteLength,
        bytes: new Uint8Array(input.bytes),
        checksum: createHash('sha256').update(input.bytes).digest('hex'),
        uploadedById: input.uploadedById,
      },
      select: LIST_FIELDS,
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId: input.uploadedById,
      action: 'ATTACHMENT_UPLOADED',
      entityType: input.entityType,
      entityId: input.entityId,
      after: { fileName: attachment.fileName, sizeBytes: attachment.sizeBytes },
    });

    return attachment;
  });
}

export async function listAttachments(companyId: string, entityType: string, entityId: string) {
  return prisma.attachment.findMany({
    where: { companyId, entityType, entityId },
    orderBy: { createdAt: 'desc' },
    select: LIST_FIELDS,
  });
}

/**
 * Reads a file back, scoped by company so one company cannot fetch another's:
 * a valid id belonging to the other company is simply not found, which is why
 * guessing an id gains nothing.
 */
export async function readAttachment(companyId: string, attachmentId: string) {
  const attachment = await prisma.attachment.findFirst({
    where: { id: attachmentId, companyId },
  });
  if (!attachment) throw new NotFoundError('Attachment');

  const bytes = Buffer.from(attachment.bytes);

  // A checksum that no longer matches means the row has been corrupted in
  // transit or at rest. Better to refuse than to hand over a damaged document
  // that somebody then relies on.
  if (attachment.checksum) {
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== attachment.checksum) {
      throw new BusinessRuleError(
        `${attachment.fileName} does not match the checksum recorded when it was uploaded, so it has been damaged. Ask for it to be attached again.`,
      );
    }
  }

  return { attachment, bytes };
}

export async function deleteAttachment(params: { companyId: string; attachmentId: string; userId: string }) {
  return transaction(async (tx) => {
    const attachment = await tx.attachment.findFirst({
      where: { id: params.attachmentId, companyId: params.companyId },
      select: LIST_FIELDS,
    });
    if (!attachment) throw new NotFoundError('Attachment');

    await tx.attachment.delete({ where: { id: attachment.id } });
    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'ATTACHMENT_DELETED',
      entityType: attachment.entityType,
      entityId: attachment.entityId,
      before: { fileName: attachment.fileName },
    });

    return { ok: true };
  });
}
