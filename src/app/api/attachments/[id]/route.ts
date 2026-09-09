import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { readAttachment } from '@/lib/services/attachment';
import { toErrorResponse } from '@/lib/errors';

/**
 * Downloads one attachment.
 *
 * The file is read through the service, which scopes the lookup by the active
 * company — so a valid id belonging to the other company is simply not found,
 * and guessing an id gains nothing. Content-Disposition is `attachment` rather
 * than `inline`: an uploaded HTML or SVG file rendered inline would run in this
 * origin, and this route serves whatever a user uploaded.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePermission(PERMISSIONS.ATTACHMENTS_VIEW);
    const { id } = await context.params;
    const { attachment, bytes } = await readAttachment(user.activeCompany.id, id);

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': attachment.mimeType,
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': `attachment; filename="${encodeURIComponent(attachment.fileName)}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    const response = toErrorResponse(error);
    return NextResponse.json({ error: response.message }, { status: response.status ?? 400 });
  }
}
