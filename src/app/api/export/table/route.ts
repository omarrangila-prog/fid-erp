import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { toErrorResponse, ValidationError } from '@/lib/errors';
import { buildWorkbook, workbookFileName, type ColumnType } from '@/lib/services/workbook';

/**
 * "Export what I am looking at", as a real Excel file.
 *
 * The report exports read their own figures from the services, which is right:
 * a report means one thing and the workbook should say it. A list screen is
 * different. The user has searched, filtered, hidden columns and sorted, and
 * what they want is that — the twelve rows in front of them, not the four
 * thousand behind them. Only the browser knows what that is.
 *
 * So the rows come from the page and this writes the workbook. It is the
 * user's own data being handed back to the same user, and it touches no
 * database: there is nothing here to leak between companies, because nothing
 * here is read from either of them.
 *
 * The alternative was to keep shipping CSV, and a CSV is not a spreadsheet:
 * no column widths, no number formats, and a quantity like 1,234.500 arrives
 * as text or, worse, as a date.
 */

const MAX_ROWS = 20_000;
const MAX_COLUMNS = 60;

const columnSchema = z.object({
  header: z.string().min(1).max(120),
  type: z.enum(['text', 'number', 'money', 'quantity', 'date', 'integer', 'percent']).optional(),
});

const bodySchema = z.object({
  title: z.string().min(1).max(80),
  subtitle: z.string().max(160).optional(),
  columns: z.array(columnSchema).min(1).max(MAX_COLUMNS),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).max(MAX_ROWS),
  /** Headers to total beneath the data. */
  totals: z.array(z.string()).max(MAX_COLUMNS).optional(),
});

export async function POST(request: Request) {
  try {
    // Authenticated, because an unauthenticated caller has no business making
    // the server do work — not because the payload is secret. It is theirs.
    //
    // The company on the title block comes from the session, never from the
    // request. A workbook stamped with the wrong company is worse than one
    // with no stamp at all, and the browser has no business asserting which
    // set of books it was looking at.
    const user = await requireUser();

    const payload: unknown = await request.json();

    // Say which limit was hit. "Could not be prepared" is true of both a
    // malformed payload and a sheet of forty thousand rows, and only one of
    // them tells the user what to do about it.
    const rowCount = Array.isArray((payload as { rows?: unknown })?.rows)
      ? ((payload as { rows: unknown[] }).rows.length)
      : 0;
    if (rowCount > MAX_ROWS) {
      throw new ValidationError(
        `That is ${rowCount.toLocaleString()} rows, and one sheet holds ${MAX_ROWS.toLocaleString()}. ` +
          'Narrow the search or the date range and export again.',
      );
    }

    const parsed = bodySchema.safeParse(payload);
    if (!parsed.success) {
      throw new ValidationError('That export could not be prepared. Reload the page and try again.');
    }
    const body = parsed.data;

    const workbook = await buildWorkbook<Array<string | number | null>>({
      companyName: user.activeCompany.name,
      title: body.title,
      subtitle: body.subtitle,
      rows: body.rows,
      totals: body.totals,
      columns: body.columns.map((column, index) => ({
        header: column.header,
        type: column.type as ColumnType | undefined,
        value: (row) => row[index] ?? null,
      })),
    });

    return new NextResponse(new Uint8Array(workbook), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Length': String(workbook.byteLength),
        'Content-Disposition': `attachment; filename="${workbookFileName(body.title, user.activeCompany.code)}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    const response = toErrorResponse(error);
    return NextResponse.json({ error: response.message }, { status: response.status ?? 400 });
  }
}
