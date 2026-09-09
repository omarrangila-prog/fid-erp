import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildWorkbook, workbookFileName } from '@/lib/services/workbook';

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

  it('names the download after the company, the report and the day', () => {
    const name = workbookFileName('Loading Follow-Up', 'FID-DXB');
    expect(name).toMatch(/^FID-DXB-loading-follow-up-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });
});
