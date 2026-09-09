'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Paperclip, Upload, Trash2, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { uploadAttachmentAction, deleteAttachmentAction } from '@/server/actions/compliance-actions';

export type AttachmentRow = {
  id: string;
  fileName: string;
  sizeLabel: string;
  uploadedBy: string;
  uploadedAt: string;
};

/**
 * Files hanging off a document: the bill of lading, the supplier's invoice, a
 * quality certificate, the signed delivery note.
 *
 * The picker is a plain file input rather than a drop zone. A drop zone that
 * also has to work on a phone and with a keyboard ends up being a file input
 * with decoration, and this one says out loud what it will and will not take.
 */
export function AttachmentPanel({
  entityType,
  entityId,
  attachments,
  canManage,
  category,
}: {
  entityType: string;
  entityId: string;
  attachments: AttachmentRow[];
  canManage: boolean;
  category?: string;
}) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = React.useState(false);
  const [removing, setRemoving] = React.useState<AttachmentRow | null>(null);

  async function upload(file: File) {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.set('file', file);
      formData.set('entityType', entityType);
      formData.set('entityId', entityId);
      if (category) formData.set('category', category);

      const result = await uploadAttachmentAction(formData);
      if (result.ok) {
        toast.success(`${file.name} attached.`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Paperclip className="size-4 text-ink-subtle" />
          Attachments
        </CardTitle>
        <CardDescription>PDF, image, spreadsheet or document, up to 20 MB each.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {attachments.length === 0 ? (
          <p className="text-xs text-ink-subtle">Nothing attached yet.</p>
        ) : (
          <ul className="space-y-2">
            {attachments.map((file) => (
              <li key={file.id} className="flex items-start justify-between gap-2 rounded-md border border-line p-2">
                <div className="min-w-0">
                  <a
                    href={`/api/attachments/${file.id}`}
                    className="flex min-h-8 items-center gap-1.5 truncate text-sm font-medium text-forest-700 hover:underline"
                  >
                    <Download className="size-3.5 shrink-0" />
                    <span className="truncate">{file.fileName}</span>
                  </a>
                  <p className="text-xs text-ink-subtle">
                    {file.sizeLabel} · {file.uploadedBy} · {file.uploadedAt}
                  </p>
                </div>
                {canManage ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove ${file.fileName}`}
                    onClick={() => setRemoving(file)}
                  >
                    <Trash2 className="text-red-500" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canManage ? (
          <>
            <input
              ref={inputRef}
              type="file"
              className="sr-only"
              accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.csv,.xls,.xlsx,.doc,.docx"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <Button variant="outline" size="sm" loading={uploading} onClick={() => inputRef.current?.click()}>
              <Upload />
              Attach a file
            </Button>
          </>
        ) : null}
      </CardContent>

      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.fileName ?? 'file'}?`}
        description="The file is deleted from storage and cannot be recovered from here."
        confirmLabel="Remove"
        variant="danger"
        onConfirm={async () => {
          if (!removing) return;
          const result = await deleteAttachmentAction(removing.id);
          if (result.ok) {
            toast.success('Attachment removed.');
            router.refresh();
          } else {
            throw new Error(result.error);
          }
        }}
      />
    </Card>
  );
}
