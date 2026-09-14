/**
 * Morocco invoices start at 0%. The statutory rate is available to pick, but
 * it must never be applied automatically.
 */
export function preferZeroRateTax<T extends { code: string; ratePct: { toString(): string } | string | number }>(
  codes: T[],
): T | undefined {
  const rateOf = (code: T) => Number(typeof code.ratePct === 'object' ? code.ratePct.toString() : code.ratePct);
  return (
    codes.find((code) => code.code === 'EXEMPT') ??
    codes.find((code) => code.code === 'ZERO') ??
    codes.find((code) => rateOf(code) === 0) ??
    codes[0]
  );
}
