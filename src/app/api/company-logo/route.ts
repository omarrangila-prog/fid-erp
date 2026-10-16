import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';

/**
 * The active company's logo — only ever the signed-in person's own company.
 *
 * There is deliberately no id in the URL: nothing a caller types can name
 * another company's logo. The image is served as an attachment-safe raster
 * with `nosniff`, and revalidated by ETag so a changed logo shows at once.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse(null, { status: 401 });

  const logo = await prisma.companyLogo.findUnique({ where: { companyId: user.activeCompany.id } });
  if (!logo) return new NextResponse(null, { status: 404 });

  const etag = `"${createHash('sha1').update(logo.bytes).digest('hex').slice(0, 20)}"`;
  const headers = {
    'Content-Type': logo.mimeType,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-cache',
    ETag: etag,
  };
  if (request.headers.get('if-none-match') === etag) return new NextResponse(null, { status: 304, headers });
  return new NextResponse(new Uint8Array(logo.bytes), { headers });
}
