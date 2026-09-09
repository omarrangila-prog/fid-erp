import 'server-only';
import { listAttachments } from '@/lib/services/attachment';
import { formatDateTime } from '@/lib/format';
import type { AttachmentRow } from '@/components/attachments/attachment-panel';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function loadAttachments(
  companyId: string,
  entityType: string,
  entityId: string,
): Promise<AttachmentRow[]> {
  const rows = await listAttachments(companyId, entityType, entityId);
  return rows.map((row) => ({
    id: row.id,
    fileName: row.fileName,
    sizeLabel: humanSize(row.sizeBytes),
    uploadedBy: row.uploadedBy.name,
    uploadedAt: formatDateTime(row.createdAt),
  }));
}
