/**
 * The short form of a document number.
 *
 * The stored number is FID-MA-SI-000008: the company, the country, the
 * document type and a sequence, so the database can tell two invoices apart
 * across two companies. None of that is what somebody means when they say
 * "invoice eight".
 *
 * So the sequence is pulled out and shown on its own with a short prefix —
 * INV 8 — while the full number stays in the database, on the printed tax
 * invoice where the law wants it, and in every search box.
 */
export function shortDocumentNumber(fullNumber: string | null | undefined, prefix = 'INV'): string {
  if (!fullNumber) return '—';
  const trailing = fullNumber.match(/(\d+)\s*$/);
  if (!trailing) return fullNumber;
  // 000008 → 8. A sequence that is genuinely zero keeps a digit.
  const sequence = String(Number(trailing[1]));
  return `${prefix} ${sequence}`;
}
