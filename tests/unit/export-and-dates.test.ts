import { describe, it, expect } from 'vitest';
import { buildWorkbook, buildCsv, csvFromWorkbook } from '@/lib/services/workbook';
import { calendarDay, dateString, optionalDecimalString } from '@/lib/validation/common';
import { companyToday, daysUntil } from '@/lib/format';
import { bucketFor } from '@/lib/services/receivables';

/**
 * Faults found in the October bug sweep, pinned so they stay fixed.
 */

describe('CSV export', () => {
  async function csvOf(rows: Array<{ d: Date | null; n: string; a: number }>) {
    const workbook = await buildWorkbook({
      companyName: 'FID Test',
      title: 'Test',
      timeZone: 'Asia/Dubai',
      rows,
      totals: ['Amount'],
      columns: [
        { header: 'Date', value: (r) => r.d, type: 'date' },
        { header: 'Name', value: (r) => r.n },
        { header: 'Amount', value: (r) => r.a, type: 'money' },
      ],
    });
    return (await csvFromWorkbook(workbook)).toString('utf8').replace(/^﻿/, '').split('\r\n');
  }

  it('writes dates as the ISO day instead of leaving them blank', async () => {
    const lines = await csvOf([{ d: new Date('2026-09-30T00:00:00Z'), n: 'Roastery', a: 10 }]);
    expect(lines).toContain('2026-09-30,Roastery,10');
  });

  it('carries the total row, which a formula alone left empty', async () => {
    const lines = await csvOf([
      { d: null, n: 'A', a: 10.1 },
      { d: null, n: 'B', a: 20.2 },
    ]);
    expect(lines.at(-1)).toBe('Total,,30.3');
  });

  it('writes a merged heading once, not once per column', async () => {
    const lines = await csvOf([{ d: null, n: 'A', a: 1 }]);
    expect(lines[0]).toBe('FID Test,,');
  });

  it('turns text a spreadsheet would run into plain text, and leaves numbers alone', async () => {
    const lines = await csvOf([
      { d: null, n: '=HYPERLINK("http://x")', a: -12.5 },
      { d: null, n: '+cmd', a: 3 },
    ]);
    expect(lines).toContain(`,"'=HYPERLINK(""http://x"")",-12.5`);
    expect(lines).toContain(`,'+cmd,3`);
  });

  it('guards hand-built CSVs the same way', () => {
    const text = buildCsv(['Name', 'Amount'], [['@SUM(A1)', -5], ['-10', 2]]).toString('utf8');
    expect(text).toContain(`'@SUM(A1),-5`);
    // A negative number written as text is still a number, not a formula.
    expect(text).toContain('-10,2');
  });
});

describe('dates', () => {
  it('refuses days that do not exist instead of rolling them over', () => {
    expect(calendarDay('2026-02-31')).toBeNull();
    expect(calendarDay('2026-1-5')).toBeNull();
    expect(calendarDay('0202-10-02')).toBeNull();
    expect(calendarDay('2026-10-02junk')).toBeNull();
    expect(calendarDay('2026-10-02')?.toISOString()).toBe('2026-10-02T00:00:00.000Z');
    expect(calendarDay('2026-10-02T13:45:00.000Z')?.toISOString()).toBe('2026-10-02T00:00:00.000Z');
    expect(dateString('Date').safeParse('2026-02-31').success).toBe(false);
  });

  it("reads today on the company's clock, not the server's", () => {
    // 21:30 UTC on 1 Oct is already 2 Oct in Dubai, still 1 Oct in Casablanca.
    const now = new Date('2026-10-01T21:30:00Z');
    expect(companyToday('Asia/Dubai', now).toISOString()).toBe('2026-10-02T00:00:00.000Z');
    expect(companyToday('Africa/Casablanca', now).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it("counts days to a due date from the company's day", () => {
    const dubaiToday = companyToday('Asia/Dubai', new Date('2026-10-01T21:30:00Z'));
    expect(daysUntil(new Date('2026-10-02T00:00:00Z'), dubaiToday)).toBe(0);
    expect(bucketFor(new Date('2026-10-01T00:00:00Z'), dubaiToday)).toBe('D1_30');
    expect(bucketFor(new Date('2026-10-02T00:00:00Z'), dubaiToday)).toBe('CURRENT');
  });
});

describe('amounts', () => {
  it('refuses a negative where none can be meant, and allows it for an opening balance', () => {
    expect(optionalDecimalString('Freight').safeParse('-5').success).toBe(false);
    expect(optionalDecimalString('Freight').safeParse('5').success).toBe(true);
    expect(optionalDecimalString('Freight').safeParse('').success).toBe(true);
    expect(optionalDecimalString('Opening balance', { allowNegative: true }).safeParse('-5').success).toBe(true);
  });
});
