import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { IMPORT_KINDS, IMPORT_SPECS, templateCsv, type ImportKind } from '@/lib/import/templates';
import { toErrorResponse } from '@/lib/errors';

/** The downloadable template for one kind of import: headers plus a worked example row. */
export async function GET(_request: Request, context: { params: Promise<{ kind: string }> }) {
  try {
    await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const { kind } = await context.params;
    if (!(IMPORT_KINDS as readonly string[]).includes(kind)) return NextResponse.json({ error: 'Unknown template.' }, { status: 404 });
    const spec = IMPORT_SPECS[kind as ImportKind];
    return new NextResponse(`﻿${templateCsv(kind as ImportKind)}`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${spec.label.toLowerCase().replace(/\s+/g, '-')}-template.csv"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    const response = toErrorResponse(error);
    return NextResponse.json({ error: response.message }, { status: response.status ?? 400 });
  }
}
