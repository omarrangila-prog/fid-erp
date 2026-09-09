import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { writeAudit } from '@/lib/services/audit';
import { transaction } from '@/lib/db';

/**
 * Document attachments.
 *
 * Files are written to disk under a generated key rather than their own name:
 * a user-supplied filename in a path is how directory traversal happens, and
 * two people uploading "invoice.pdf" must not collide. The original name is
 * kept in the database for display and for the download.
 *
 * Storage lives behind this module, so moving to object storage later means
 * changing these four functions and nothing else.
 */

const STORAGE_DIR = process.env.ATTACHMENT_DIR ?? path.join(process.cwd(), 'storage', 'attachments');
const MAX_BYTES = Number(process.env.ATTACHMENT_MAX_BYTES ?? 20 * 1024 * 1024);

/** Types a trading business actually attaches. Anything else is refused. */
const ALLOWED = new Map<string, string>([
  ['application/pdf', 'pdf'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/heic', 'heic'],
  ['text/csv', 'csv'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/msword', 'doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
]);

export function isAllowedType(mimeType: string): boolean {
  return ALLOWED.has(mimeType);
}

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
      `Files of type ${input.mimeType} are not accepted. Attach a PDF, an image, a spreadsheet or a document.`,
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

  const extension = ALLOWED.get(input.mimeType)!;
  // Company-scoped directory, generated name: the uploader never influences the path.
  const storageKey = path.posix.join(input.companyId, `${randomUUID()}.${extension}`);
  const absolute = path.join(STORAGE_DIR, storageKey);

  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, input.bytes);

  return transaction(async (tx) => {
    const attachment = await tx.attachment.create({
      data: {
        companyId: input.companyId,
        entityType: input.entityType,
        entityId: input.entityId,
        category: input.category ?? null,
        fileName: input.fileName.slice(0, 200),
        mimeType: input.mimeType,
        sizeBytes: input.bytes.byteLength,
        storageKey,
        checksum: createHash('sha256').update(input.bytes).digest('hex'),
        uploadedById: input.uploadedById,
      },
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
    include: { uploadedBy: { select: { name: true } } },
  });
}

/** Reads a file back, scoped by company so one company cannot fetch another's. */
export async function readAttachment(companyId: string, attachmentId: string) {
  const attachment = await prisma.attachment.findFirst({
    where: { id: attachmentId, companyId },
  });
  if (!attachment) throw new NotFoundError('Attachment');

  const absolute = path.join(STORAGE_DIR, attachment.storageKey);
  // The key is generated, but resolve anyway: defence in depth costs nothing.
  if (!path.resolve(absolute).startsWith(path.resolve(STORAGE_DIR))) {
    throw new NotFoundError('Attachment');
  }

  const bytes = await readFile(absolute).catch(() => null);
  if (!bytes) {
    throw new NotFoundError('Attachment file');
  }
  return { attachment, bytes };
}

export async function deleteAttachment(params: { companyId: string; attachmentId: string; userId: string }) {
  return transaction(async (tx) => {
    const attachment = await tx.attachment.findFirst({
      where: { id: params.attachmentId, companyId: params.companyId },
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

    // The row is the record; a leftover file is harmless, a missing row is not.
    await unlink(path.join(STORAGE_DIR, attachment.storageKey)).catch(() => undefined);
    return { ok: true };
  });
}
