import { CURRENCY_DISPLAY_SCALE, dec, type DecimalInput } from '@/lib/money';

/**
 * Presentation helpers. Amounts are always shown with the ISO currency code
 * rather than a bare symbol — "USD 12,450.00", never "$12,450.00" — because
 * this system routinely shows three currencies side by side.
 */

export function formatMoney(value: DecimalInput | null | undefined, currency: string, options?: { showCode?: boolean }): string {
  const scale = CURRENCY_DISPLAY_SCALE[currency?.toUpperCase()] ?? 2;
  const amount = dec(value ?? 0).toFixed(scale);
  const [whole, fraction] = amount.split('.');
  const negative = whole.startsWith('-');
  const digits = negative ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `${negative ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`;
  return options?.showCode === false ? body : `${currency.toUpperCase()} ${body}`;
}

/** Compact form for dashboard cards: USD 1.24M */
export function formatMoneyCompact(value: DecimalInput | null | undefined, currency: string): string {
  const n = dec(value ?? 0);
  const abs = n.abs();
  const sign = n.isNegative() ? '-' : '';
  const code = currency.toUpperCase();
  if (abs.greaterThanOrEqualTo(1_000_000_000)) return `${code} ${sign}${abs.dividedBy(1_000_000_000).toFixed(2)}B`;
  if (abs.greaterThanOrEqualTo(1_000_000)) return `${code} ${sign}${abs.dividedBy(1_000_000).toFixed(2)}M`;
  if (abs.greaterThanOrEqualTo(10_000)) return `${code} ${sign}${abs.dividedBy(1_000).toFixed(1)}K`;
  return formatMoney(n, code);
}

export function formatQuantityKg(value: DecimalInput | null | undefined, options?: { unit?: boolean }): string {
  const amount = dec(value ?? 0).toFixed(3).replace(/\.?0+$/, '');
  const [whole, fraction] = amount.split('.');
  const negative = whole.startsWith('-');
  const digits = negative ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `${negative ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`;
  return options?.unit === false ? body : `${body} KG`;
}

/** Shows kilograms as metric tons, which is how traders talk about volume. */
export function formatQuantityMt(value: DecimalInput | null | undefined): string {
  const mt = dec(value ?? 0).dividedBy(1000);
  return `${mt.toFixed(3).replace(/\.?0+$/, '')} MT`;
}

export function formatPercent(value: DecimalInput | null | undefined): string {
  return `${dec(value ?? 0).toFixed(2)}%`;
}

export function formatRate(value: DecimalInput | null | undefined): string {
  const s = dec(value ?? 0).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  return s || '0';
}

const DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const DATETIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return DATE_FORMATTER.format(d);
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return `${DATETIME_FORMATTER.format(d)} UTC`;
}

/** ISO yyyy-mm-dd, suitable for <input type="date"> round-tripping. */
export function toDateInputValue(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/** Whole days from today until `value`. Negative when the date has passed. */
export function daysUntil(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  const a = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const b = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((a - b) / 86_400_000);
}

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}
