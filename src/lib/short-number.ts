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

/** The client's word for each kind of document, keyed by the code inside its stored number. */
const BUSINESS_PREFIX: Record<string, string> = {
  SI: 'INV',
  RV: 'PAY',
  PV: 'PMT',
  EV: 'EXP',
  JV: 'JV',
  PO: 'PO',
  PB: 'BILL',
  CN: 'CN',
  DN: 'DN',
  AGS: 'SET',
  GRN: 'GRN',
  SC: 'COUNT',
};

/**
 * Any stored document number in its short, readable form: FID-MA-RV-000021
 * becomes PAY 21, FID-MA-JV-000086 becomes JV 86. A number that does not
 * follow the stored pattern — something typed by hand — is shown as it is.
 */
export function businessNumber(fullNumber: string | null | undefined): string {
  if (!fullNumber) return '—';
  const match = fullNumber.match(/-([A-Z]{2,4})-(\d+)\s*$/);
  if (!match) return fullNumber;
  const prefix = BUSINESS_PREFIX[match[1]] ?? match[1];
  return `${prefix} ${Number(match[2])}`;
}
