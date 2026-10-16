/**
 * Reads an uploaded CSV or Excel file into a plain table.
 *
 * No validation here — just "what cells are in the file". A table is the
 * header row plus the data rows, every cell a trimmed string, with blank rows
 * dropped. Kept free of Next/Prisma so it can be unit-tested and reused.
 */

export type Table = { headers: string[]; rows: string[][] };

const MAX_ROWS = 20_000;

/** RFC 4180 parser: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  // Choose the delimiter from the header line: whichever of , ; tab appears most outside quotes.
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => {
    let n = 0;
    let quoted = false;
    for (const c of firstLine) {
      if (c === '"') quoted = !quoted;
      else if (c === ch && !quoted) n += 1;
    }
    return n;
  };
  const delimiter = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < clean.length; i += 1) {
    const c = clean[i];
    if (quoted) {
      if (c === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function toTable(raw: string[][]): Table {
  const trimmed = raw.map((r) => r.map((c) => c.replace(/\s+/g, ' ').trim()));
  const nonBlank = trimmed.filter((r) => r.some((c) => c !== ''));
  if (nonBlank.length === 0) return { headers: [], rows: [] };
  if (nonBlank.length - 1 > MAX_ROWS) {
    throw new Error(`That file has more than ${MAX_ROWS.toLocaleString('en-US')} rows. Split it and import in parts.`);
  }
  const [headers, ...rows] = nonBlank;
  const width = headers.length;
  return { headers, rows: rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')) };
}

export function tableFromCsv(text: string): Table {
  return toTable(parseCsv(text));
}

/** Excel dates arrive as Date objects; render them as ISO days so one parser handles both formats. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const v = value as { text?: unknown; result?: unknown; richText?: Array<{ text: string }> };
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if (v.result !== undefined) return cellText(v.result);
    if (typeof v.text === 'string') return v.text;
    return '';
  }
  return String(value);
}

export async function tableFromXlsx(buffer: ArrayBuffer | Buffer): Promise<Table> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };
  const raw: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cells[col - 1] = cellText(cell.value);
    });
    raw.push(Array.from(cells, (c) => c ?? ''));
  });
  return toTable(raw);
}

export async function readUpload(file: { name: string; bytes: ArrayBuffer }): Promise<Table> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx')) return tableFromXlsx(file.bytes);
  if (name.endsWith('.csv') || name.endsWith('.txt') || name.endsWith('.tsv')) {
    return tableFromCsv(new TextDecoder('utf-8').decode(file.bytes));
  }
  throw new Error('Upload a .csv or .xlsx file. Older .xls files should be saved as .xlsx first.');
}

/** Writes rows back as CSV (for the downloadable templates and error reports). */
export function toCsv(headers: string[], rows: string[][]): string {
  const esc = (v: string) => (/[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [headers, ...rows].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}
