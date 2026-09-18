import { formatDate } from '@/lib/format';

/**
 * What to call a document on screen, now that its number is not shown.
 *
 * The client asked for the system's own numbering to stay out of sight:
 * FID-MA-SI-000008 is issued so the database can tell two invoices apart, and
 * that is not a question anybody running a coffee business asks. But a row in
 * a ledger still has to be identifiable, so each document is named by what it
 * is, who it was with, and when — which is how people describe them anyway:
 * "the payment to Fazenda in March", not "PV-000012".
 *
 * The numbers still exist and still find the record when typed into a search
 * box; they are simply not printed at people.
 */
export function documentLabel(
  kind: string,
  date?: Date | string | null,
  party?: string | null,
): string {
  const who = party?.trim();
  const when = date ? formatDate(date) : null;
  return [kind, who ? `— ${who}` : null, when ? `· ${when}` : null].filter(Boolean).join(' ');
}

/** The short form, for a cell in a table that already carries a date column. */
export function documentKind(kind: string, party?: string | null): string {
  const who = party?.trim();
  return who ? `${kind} — ${who}` : kind;
}
