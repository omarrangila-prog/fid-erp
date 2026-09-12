import 'server-only';
import ExcelJS from 'exceljs';

/**
 * Real Excel files.
 *
 * A CSV opens in Excel but it is not a spreadsheet: no column widths, no
 * number formats, no frozen header, and a figure like 1,234.50 arrives as
 * text or, worse, as a date. This writes genuine .xlsx — the client opens it
 * and it is already formatted, already filterable, and the totals already add
 * up in the status bar.
 *
 * The sheet carries a title block naming the company, the report and the
 * period, because a spreadsheet gets emailed on and detached from wherever it
 * came from.
 */

export type ColumnType = 'text' | 'number' | 'money' | 'quantity' | 'date' | 'integer' | 'percent';

const FORMATS: Record<ColumnType, string | undefined> = {
  text: undefined,
  integer: '#,##0',
  number: '#,##0.00',
  money: '#,##0.00',
  quantity: '#,##0.000',
  date: 'dd mmm yyyy',
  // Excel multiplies by 100 itself, so the value stays a fraction.
  percent: '0.0%',
};

/** Sensible widths, so nothing arrives as ####. */
const WIDTHS: Record<ColumnType, number> = {
  text: 22,
  integer: 12,
  number: 16,
  money: 16,
  quantity: 16,
  date: 14,
  percent: 10,
};

const FOREST = 'FF1B3A2F';
const IVORY = 'FFF7F4EC';

export async function buildWorkbook<T>(params: {
  companyName: string;
  title: string;
  subtitle?: string;
  columns: Array<{
    header: string;
    value: (row: T) => string | number | Date | null | undefined;
    type?: ColumnType;
    width?: number;
  }>;
  rows: T[];
  /** Columns to total, by header. Written as a bold row beneath the data. */
  totals?: string[];
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = params.companyName;
  workbook.created = new Date();

  // Excel refuses : \ / ? * [ ] in a sheet name and truncates past 31 chars.
  const sheet = workbook.addWorksheet(params.title.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31), {
    views: [{ state: 'frozen', ySplit: 4 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const columnCount = params.columns.length;

  // Striping writes a fill object onto every cell of every other row, which is
  // most of the cost of a large export. Past a few thousand rows nobody is
  // reading the sheet by eye anyway — they are filtering and totalling it — so
  // the stripes are dropped rather than the rows.
  const banded = params.rows.length <= 5_000;

  // --- Title block ---------------------------------------------------------
  writeTitleBlock(sheet, params.companyName, params.title, params.subtitle, columnCount);

  // --- Header row ----------------------------------------------------------
  const headerRow = sheet.getRow(4);
  params.columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FOREST } };
    cell.alignment = { vertical: 'middle', horizontal: isNumeric(column.type) ? 'right' : 'left', wrapText: true };
  });
  headerRow.height = 22;

  // --- Body ----------------------------------------------------------------
  params.rows.forEach((row, rowIndex) => {
    const sheetRow = sheet.getRow(5 + rowIndex);
    params.columns.forEach((column, columnIndex) => {
      const cell = sheetRow.getCell(columnIndex + 1);
      const raw = column.value(row);
      cell.value = raw ?? (isNumeric(column.type) ? 0 : '');

      const format = FORMATS[column.type ?? 'text'];
      if (format) cell.numFmt = format;
      if (isNumeric(column.type)) cell.alignment = { horizontal: 'right' };
    });

    // Banding, which is what makes a long sheet readable on paper.
    if (rowIndex % 2 === 1 && banded) {
      sheetRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: IVORY } };
      });
    }
  });

  // --- Totals --------------------------------------------------------------
  if (params.totals?.length && params.rows.length > 0) {
    const totalRow = sheet.getRow(5 + params.rows.length);
    totalRow.getCell(1).value = 'Total';
    totalRow.getCell(1).font = { bold: true };

    params.columns.forEach((column, index) => {
      if (!params.totals!.includes(column.header)) return;
      const cell = totalRow.getCell(index + 1);
      const letter = sheet.getColumn(index + 1).letter;
      // A formula rather than a computed number, so the client can filter the
      // sheet and watch the total follow.
      cell.value = { formula: `SUBTOTAL(109,${letter}5:${letter}${4 + params.rows.length})` };
      cell.numFmt = FORMATS[column.type ?? 'number'] ?? FORMATS.number!;
      cell.font = { bold: true };
      cell.alignment = { horizontal: 'right' };
    });

    totalRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = { top: { style: 'thin', color: { argb: FOREST } } };
    });
  }

  // --- Widths and filter ---------------------------------------------------
  //
  // Sampled, not exhaustive. A width is cosmetic and the longest customer name
  // in the first few hundred rows is as good a guide as the longest in twenty
  // thousand — and measuring every cell of every column was the single slowest
  // thing about a large export.
  const WIDTH_SAMPLE = 500;
  const sample = params.rows.length > WIDTH_SAMPLE ? params.rows.slice(0, WIDTH_SAMPLE) : params.rows;

  params.columns.forEach((column, index) => {
    const sheetColumn = sheet.getColumn(index + 1);
    const longest = sample.reduce((width, row) => {
      const value = column.value(row);
      return Math.max(width, String(value ?? '').length);
    }, column.header.length);
    sheetColumn.width = column.width ?? Math.min(46, Math.max(WIDTHS[column.type ?? 'text'], longest + 3));
  });

  if (params.rows.length > 0) {
    sheet.autoFilter = {
      from: { row: 4, column: 1 },
      to: { row: 4 + params.rows.length, column: columnCount },
    };
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function isNumeric(type: ColumnType | undefined): boolean {
  return type === 'number' || type === 'money' || type === 'quantity' || type === 'integer' || type === 'percent';
}

/** The filename an export downloads as: report, company and date. */
export function workbookFileName(title: string, companyCode: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${companyCode}-${slug}-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

// ---------------------------------------------------------------------------
// Financial statements
// ---------------------------------------------------------------------------

/**
 * A statement is not a table.
 *
 * A trial balance is a list and `buildWorkbook` suits it. A profit and loss,
 * a balance sheet or a VAT return is a shape: headings, indented lines beneath
 * them, subtotals that are struck through, and a bottom line. Flattening that
 * into a filterable grid loses the only thing that made it readable, so this
 * writes the shape instead — no auto-filter, because sorting a balance sheet
 * by amount produces nonsense.
 */
export type StatementRow =
  | { kind: 'section'; label: string }
  | { kind: 'line'; label: string; code?: string; values: Array<number | string | null> }
  | { kind: 'total'; label: string; values: Array<number | string | null> }
  | { kind: 'grand'; label: string; values: Array<number | string | null> }
  | { kind: 'note'; label: string }
  | { kind: 'spacer' };

export async function buildStatementWorkbook(params: {
  companyName: string;
  title: string;
  subtitle?: string;
  /** Heading for the description column. */
  labelHeader: string;
  /** True when lines carry an account code, written in its own narrow column. */
  showCodes?: boolean;
  /** The value columns, left to right. */
  columns: Array<{ header: string; type?: ColumnType; width?: number }>;
  rows: StatementRow[];
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = params.companyName;
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(params.title.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31), {
    views: [{ state: 'frozen', ySplit: 4 }],
    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const codeColumns = params.showCodes ? 1 : 0;
  const firstValueColumn = 1 + codeColumns + 1;
  const columnCount = codeColumns + 1 + params.columns.length;

  // --- Title block ---------------------------------------------------------
  writeTitleBlock(sheet, params.companyName, params.title, params.subtitle, columnCount);

  // --- Header row ----------------------------------------------------------
  const headerRow = sheet.getRow(4);
  const headers = [
    ...(params.showCodes ? ['Code'] : []),
    params.labelHeader,
    ...params.columns.map((column) => column.header),
  ];
  headers.forEach((header, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FOREST } };
    cell.alignment = {
      vertical: 'middle',
      horizontal: index + 1 >= firstValueColumn ? 'right' : 'left',
      wrapText: true,
    };
  });
  headerRow.height = 22;

  // --- Body ----------------------------------------------------------------
  let rowNumber = 5;
  for (const row of params.rows) {
    const sheetRow = sheet.getRow(rowNumber);

    if (row.kind === 'spacer') {
      rowNumber += 1;
      continue;
    }

    if (row.kind === 'section') {
      sheet.mergeCells(rowNumber, 1, rowNumber, columnCount);
      const cell = sheet.getCell(rowNumber, 1);
      cell.value = row.label;
      cell.font = { bold: true, size: 11, color: { argb: FOREST } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: IVORY } };
      cell.alignment = { vertical: 'middle' };
      sheetRow.height = 18;
      rowNumber += 1;
      continue;
    }

    if (row.kind === 'note') {
      sheet.mergeCells(rowNumber, 1, rowNumber, columnCount);
      const cell = sheet.getCell(rowNumber, 1);
      cell.value = row.label;
      cell.font = { italic: true, size: 9, color: { argb: 'FF8A857C' } };
      rowNumber += 1;
      continue;
    }

    const bold = row.kind === 'total' || row.kind === 'grand';

    if (params.showCodes) {
      const codeCell = sheetRow.getCell(1);
      codeCell.value = row.kind === 'line' ? (row.code ?? '') : '';
      codeCell.font = { bold };
    }

    const labelCell = sheetRow.getCell(1 + codeColumns);
    labelCell.value = row.label;
    labelCell.font = { bold };
    // Lines sit under their heading; totals sit level with it.
    labelCell.alignment = { indent: row.kind === 'line' ? 1 : 0 };

    row.values.forEach((value, index) => {
      const column = params.columns[index];
      if (!column) return;
      const cell = sheetRow.getCell(firstValueColumn + index);

      // A statement has cells that genuinely have no value — a subtotal has no
      // document count, an overhead has no per-currency balance. Writing 0
      // there would state something false: zero documents, a nil balance. Null
      // means "not applicable here", so the cell stays empty.
      cell.value = value === null || value === undefined ? null : value;

      const format = FORMATS[column.type ?? 'money'];
      if (format && typeof cell.value === 'number') cell.numFmt = format;
      cell.font = { bold };
      cell.alignment = { horizontal: 'right' };
    });

    if (row.kind === 'total' || row.kind === 'grand') {
      const style = row.kind === 'grand' ? 'double' : 'thin';
      for (let column = 1; column <= columnCount; column += 1) {
        sheetRow.getCell(column).border = { top: { style: 'thin', color: { argb: FOREST } } };
        if (row.kind === 'grand') {
          sheetRow.getCell(column).border = {
            top: { style: 'thin', color: { argb: FOREST } },
            bottom: { style, color: { argb: FOREST } },
          };
        }
      }
    }

    rowNumber += 1;
  }

  // --- Widths --------------------------------------------------------------
  if (params.showCodes) sheet.getColumn(1).width = 10;
  sheet.getColumn(1 + codeColumns).width = params.rows.reduce((width, row) => {
    const label = 'label' in row ? row.label : '';
    return Math.max(width, Math.min(52, label.length + 4));
  }, params.labelHeader.length + 4);

  params.columns.forEach((column, index) => {
    sheet.getColumn(firstValueColumn + index).width =
      column.width ?? Math.max(WIDTHS[column.type ?? 'money'], column.header.length + 3);
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function writeTitleBlock(
  sheet: ExcelJS.Worksheet,
  companyName: string,
  title: string,
  subtitle: string | undefined,
  columnCount: number,
): void {
  sheet.mergeCells(1, 1, 1, columnCount);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = companyName;
  titleCell.font = { bold: true, size: 14, color: { argb: FOREST } };

  sheet.mergeCells(2, 1, 2, columnCount);
  const subjectCell = sheet.getCell(2, 1);
  subjectCell.value = subtitle ? `${title} — ${subtitle}` : title;
  subjectCell.font = { size: 11, color: { argb: 'FF44403A' } };

  sheet.mergeCells(3, 1, 3, columnCount);
  const stampCell = sheet.getCell(3, 1);
  stampCell.value = `Exported ${new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`;
  stampCell.font = { size: 9, italic: true, color: { argb: 'FF8A857C' } };
}
