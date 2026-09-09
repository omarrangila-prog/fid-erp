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

export type ColumnType = 'text' | 'number' | 'money' | 'quantity' | 'date' | 'integer';

const FORMATS: Record<ColumnType, string | undefined> = {
  text: undefined,
  integer: '#,##0',
  number: '#,##0.00',
  money: '#,##0.00',
  quantity: '#,##0.000',
  date: 'dd mmm yyyy',
};

/** Sensible widths, so nothing arrives as ####. */
const WIDTHS: Record<ColumnType, number> = {
  text: 22,
  integer: 12,
  number: 16,
  money: 16,
  quantity: 16,
  date: 14,
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

  // --- Title block ---------------------------------------------------------
  sheet.mergeCells(1, 1, 1, columnCount);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = params.companyName;
  titleCell.font = { bold: true, size: 14, color: { argb: FOREST } };

  sheet.mergeCells(2, 1, 2, columnCount);
  const subjectCell = sheet.getCell(2, 1);
  subjectCell.value = params.subtitle ? `${params.title} — ${params.subtitle}` : params.title;
  subjectCell.font = { size: 11, color: { argb: 'FF44403A' } };

  sheet.mergeCells(3, 1, 3, columnCount);
  const stampCell = sheet.getCell(3, 1);
  stampCell.value = `Exported ${new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`;
  stampCell.font = { size: 9, italic: true, color: { argb: 'FF8A857C' } };

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
    if (rowIndex % 2 === 1) {
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
  params.columns.forEach((column, index) => {
    const sheetColumn = sheet.getColumn(index + 1);
    const longest = params.rows.reduce((width, row) => {
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
  return type === 'number' || type === 'money' || type === 'quantity' || type === 'integer';
}

/** The filename an export downloads as: report, company and date. */
export function workbookFileName(title: string, companyCode: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${companyCode}-${slug}-${new Date().toISOString().slice(0, 10)}.xlsx`;
}
