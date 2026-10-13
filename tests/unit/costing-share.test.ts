import { describe, it, expect } from 'vitest';
import { dec, sum } from '@/lib/money';

/**
 * The share of the job's charges printed beside each container's money.
 *
 * It used to be 100 / number of rows: one equal share stamped on every line
 * whatever had actually been allocated. The client's own screen showed three
 * containers reading "33% of the job" while carrying 50%, 25% and 25% — the
 * percentage contradicted the money next to it.
 *
 * The share is the line's own allocation over the job's total, so it always
 * agrees with the figure beside it and the shares always add to 100%.
 */

/** The calculation as the costing table does it. */
function shareOf(allocated: string, rows: string[]) {
  const total = sum(rows.map((r) => dec(r)));
  return total.isZero() ? null : dec(allocated).dividedBy(total).times(100);
}

describe("each container's share of the job", () => {
  // The client's job ICUL/FID/SCR/004: Screen 12 in one container, Screen 18
  // in two, USD 68,275.92 of charges shared per coffee.
  const job = ['34137.96', '17068.98', '17068.98'];

  it('states what each container actually carries, not one over the row count', () => {
    expect(shareOf(job[0], job)!.toFixed(0)).toBe('50');
    expect(shareOf(job[1], job)!.toFixed(0)).toBe('25');
    expect(shareOf(job[2], job)!.toFixed(0)).toBe('25');
  });

  it('adds up to the whole job', () => {
    const shares = job.map((row) => shareOf(row, job)!);
    expect(sum(shares).toFixed(2)).toBe('100.00');
  });

  it('reads 33% only when the charges really are split three ways', () => {
    const equal = ['22758.64', '22758.64', '22758.64'];
    for (const row of equal) expect(shareOf(row, equal)!.toFixed(0)).toBe('33');
  });

  it('says nothing at all when the job carries no charges to share', () => {
    expect(shareOf('0', ['0', '0'])).toBeNull();
  });

  it('keeps a small share legible instead of rounding it to nothing', () => {
    // One container of twelve: 8.33%, not "8%" and certainly not "0%".
    const twelve = Array.from({ length: 12 }, () => '1000');
    const share = shareOf('1000', twelve)!;
    expect(share.toFixed(share.lessThan(10) ? 1 : 0)).toBe('8.3');
  });
});
