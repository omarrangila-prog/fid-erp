import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildWorkbook, buildStatementWorkbook, workbookFileName, type StatementRow } from '@/lib/services/workbook';

/**
 * The Excel export.
 *
 * A CSV opens in Excel but is not a spreadsheet. These assert that what the
 * client downloads is a real workbook — read back with the same library that
 * wrote it, so a file Excel would reject cannot pass.
 */

type Row = { ref: string; kilos: number; value: number; date: Date };

const ROWS: Row[] = [
  { ref: 'INV JAN26/3995', kilos: 19_200, value: 119_040, date: new Date('2026-01-08T00:00:00Z') },
  { ref: 'Cooxupé, Cooperativa', kilos: 18_000, value: 81_306.56, date: new Date('2026-02-14T00:00:00Z') },
];

async function build() {
  const buffer = await buildWorkbook<Row>({
    companyName: 'FID Trading L.L.C.',
    title: 'Loading Follow-Up',
    subtitle: '2 containers on the book',
    rows: ROWS,
    totals: ['Quantity (KG)', 'Value'],
    columns: [
      { header: 'Contract ref', value: (r) => r.ref },
      { header: 'Contract date', value: (r) => r.date, type: 'date' },
      { header: 'Quantity (KG)', value: (r) => r.kilos, type: 'quantity' },
      { header: 'Value', value: (r) => r.value, type: 'money' },
    ],
  });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return { buffer, sheet: workbook.worksheets[0] };
}

describe('the Excel export', () => {
  it('produces a file Excel can open', async () => {
    const { buffer } = await build();
    // An .xlsx is a zip; every one starts PK.
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    expect(buffer.byteLength).toBeGreaterThan(2_000);
  });

  it('names the company and the report on the sheet itself', async () => {
    const { sheet } = await build();
    // A spreadsheet gets emailed on and detached from where it came from.
    expect(sheet.getCell('A1').value).toBe('FID Trading L.L.C.');
    expect(String(sheet.getCell('A2').value)).toContain('Loading Follow-Up');
    expect(String(sheet.getCell('A3').value)).toMatch(/^Exported /);
  });

  it('writes numbers as numbers, not as text', async () => {
    const { sheet } = await build();
    // Row 4 is the header; the data starts at 5.
    expect(sheet.getCell('C5').value).toBe(19_200);
    expect(sheet.getCell('D5').value).toBe(119_040);
    expect(typeof sheet.getCell('C5').value).toBe('number');
  });

  it('writes dates as dates, so sorting and filtering work', async () => {
    const { sheet } = await build();
    expect(sheet.getCell('B5').value).toBeInstanceOf(Date);
    expect(sheet.getCell('B5').numFmt).toBe('dd mmm yyyy');
  });

  it('formats money and quantity to the right number of places', async () => {
    const { sheet } = await build();
    expect(sheet.getCell('C5').numFmt).toBe('#,##0.000');
    expect(sheet.getCell('D5').numFmt).toBe('#,##0.00');
  });

  it('keeps a comma inside a value in one cell', async () => {
    const { sheet } = await build();
    // The failure a CSV makes easy: a supplier name with a comma in it.
    expect(sheet.getCell('A6').value).toBe('Cooxupé, Cooperativa');
  });

  it('totals with SUBTOTAL, so the figure follows a filter', async () => {
    const { sheet } = await build();
    const total = sheet.getCell('C7').value as { formula?: string };
    expect(total.formula).toBe('SUBTOTAL(109,C5:C6)');
  });

  it('freezes the header and turns on the filter', async () => {
    const { sheet } = await build();
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 4 });
    expect(sheet.autoFilter).toBeTruthy();
  });

  it('gives every column a width wide enough for its longest value', async () => {
    const { sheet } = await build();
    // "Cooxupé, Cooperativa" is 20 characters, so the column cannot be 12.
    expect(sheet.getColumn(1).width).toBeGreaterThanOrEqual(21);
  });

  it('writes a share as a percentage Excel understands', async () => {
    const buffer = await buildWorkbook<{ label: string; share: number }>({
      companyName: 'FID Trading L.L.C.',
      title: 'Expense Report',
      rows: [{ label: 'Shipment expenses', share: 0.6965798527782698 }],
      columns: [
        { header: 'Type', value: (r) => r.label },
        { header: 'Share', value: (r) => r.share, type: 'percent' },
      ],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    // Stored as the fraction; Excel does the ×100. Formatted as a number it
    // read "0.70", which a client would take for seventy cents.
    expect(sheet.getCell('B5').value).toBeCloseTo(0.6965798, 6);
    expect(sheet.getCell('B5').numFmt).toBe('0.0%');
  });

  it('names the download after the company, the report and the day', () => {
    const name = workbookFileName('Loading Follow-Up', 'FID-DXB');
    expect(name).toMatch(/^FID-DXB-loading-follow-up-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });
});


/**
 * A statement is not a table.
 *
 * A profit and loss has a shape — headings, indented lines, struck-through
 * subtotals, a bottom line. Flattening it into a filterable grid loses the
 * only thing that made it readable, so these check the shape survives the
 * round trip into a real .xlsx.
 */
const STATEMENT: StatementRow[] = [
  { kind: 'section', label: 'Revenue' },
  { kind: 'line', label: 'Coffee sales', code: '4000', values: [119_040, 437_154.24] },
  { kind: 'total', label: 'Total revenue', values: [119_040, 437_154.24] },
  { kind: 'spacer' },
  { kind: 'section', label: 'Cost of sales' },
  { kind: 'line', label: 'Cost of coffee sold', code: '5000', values: [108_500, 398_466.25] },
  { kind: 'grand', label: 'Net profit', values: [10_540, 38_687.99] },
  { kind: 'note', label: 'Net margin 8.9% of revenue' },
];

async function buildStatement() {
  const buffer = await buildStatementWorkbook({
    companyName: 'FID Trading L.L.C.',
    title: 'Profit and Loss',
    subtitle: '01 Jan 2026 to 30 Jun 2026',
    labelHeader: 'Account',
    showCodes: true,
    columns: [
      { header: 'USD', type: 'money' },
      { header: 'AED', type: 'money' },
    ],
    rows: STATEMENT,
  });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return { buffer, sheet: workbook.worksheets[0] };
}

describe('a financial statement as a workbook', () => {
  it('produces a file Excel can open', async () => {
    const { buffer } = await buildStatement();
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
  });

  it('carries the company, the report and the period', async () => {
    const { sheet } = await buildStatement();
    expect(sheet.getCell('A1').value).toBe('FID Trading L.L.C.');
    expect(String(sheet.getCell('A2').value)).toContain('01 Jan 2026 to 30 Jun 2026');
  });

  it('writes a heading across the sheet, not into one column', async () => {
    const { sheet } = await buildStatement();
    // Row 5 is the first body row: the "Revenue" heading.
    expect(sheet.getCell('A5').value).toBe('Revenue');
    expect(sheet.getCell('A5').font?.bold).toBe(true);
  });

  it('puts the account code in its own column and indents the line beneath its heading', async () => {
    const { sheet } = await buildStatement();
    expect(sheet.getCell('A6').value).toBe('4000');
    expect(sheet.getCell('B6').value).toBe('Coffee sales');
    expect(sheet.getCell('B6').alignment?.indent).toBe(1);
    // A subtotal sits level with its heading, not indented with the lines.
    // Excel writes no indent at all for zero, which is the same thing.
    expect(sheet.getCell('B7').alignment?.indent ?? 0).toBe(0);
  });

  it('writes figures as numbers in both currencies', async () => {
    const { sheet } = await buildStatement();
    expect(sheet.getCell('C6').value).toBe(119_040);
    expect(sheet.getCell('D6').value).toBe(437_154.24);
    expect(sheet.getCell('C6').numFmt).toBe('#,##0.00');
  });

  it('rules a subtotal and double-rules the bottom line', async () => {
    const { sheet } = await buildStatement();
    expect(sheet.getCell('C7').border?.top?.style).toBe('thin');
    // Row 8 is the blank spacer, 9 the Cost of sales heading, 10 the line,
    // 11 the net profit.
    expect(sheet.getCell('C11').value).toBe(10_540);
    expect(sheet.getCell('C11').border?.bottom?.style).toBe('double');
  });

  it('does not offer to sort a balance sheet by amount', async () => {
    const { sheet } = await buildStatement();
    // Filtering a statement reorders it into nonsense, so there is no filter.
    expect(sheet.autoFilter).toBeFalsy();
  });

  it('leaves a blank cell blank rather than writing a misleading zero', async () => {
    const buffer = await buildStatementWorkbook({
      companyName: 'FID Trading International SARL',
      title: 'TVA Return',
      labelHeader: 'Band',
      columns: [
        { header: 'Documents', type: 'integer' },
        { header: 'Tax MAD', type: 'money' },
      ],
      rows: [{ kind: 'total', label: 'Output tax', values: [null, 1_234.5] }],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    // A subtotal has no document count. "0" would state a real count of none.
    expect(sheet.getCell('B5').value).toBeNull();
    expect(sheet.getCell('C5').value).toBe(1_234.5);
  });
});
