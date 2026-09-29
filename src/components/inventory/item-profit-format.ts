import { formatMoney, formatQuantityKg } from '@/lib/format';
import type { Pair } from '@/lib/services/item-profitability';

/**
 * The item view's figures as text, built on the server so no Decimal reaches
 * the browser: the company's currency first, the USD equivalent under it —
 * each transaction at its own rate, never one rate for the lot.
 */
export type PairText = { primary: string; equivalent: { text: string; title: string } | null };

const EQUIVALENT_TITLE = 'The USD equivalent — each transaction at its own historical rate';

export function pairText(value: Pair | null | undefined, local: string, suffix = ''): PairText | null {
  if (!value) return null;
  return {
    primary: `${formatMoney(value.local, local)}${suffix}`,
    equivalent: local.toUpperCase() === 'USD' ? null : { text: `≈ ${formatMoney(value.usd, 'USD')}${suffix}`, title: EQUIVALENT_TITLE },
  };
}

export function perKgText(value: Pair | null | undefined, local: string): PairText | null {
  return pairText(value, local, ' / KG');
}

/** Profit reads as a profit, a loss as a loss — never a bare minus sign. */
export function profitText(value: Pair, local: string): PairText & { loss: boolean; label: 'Gross profit' | 'Gross loss' } {
  const loss = value.local.isNegative();
  const abs: Pair = { local: value.local.abs(), usd: value.usd.abs() };
  const text = pairText(abs, local)!;
  return {
    primary: loss ? `Loss ${text.primary}` : text.primary,
    equivalent: text.equivalent,
    loss,
    label: loss ? 'Gross loss' : 'Gross profit',
  };
}

export function kg(value: Parameters<typeof formatQuantityKg>[0]): string {
  return formatQuantityKg(value);
}

/** Stock status in the words the filter and the badge use. */
export const STOCK_STATUS_META: Record<'IN_STOCK' | 'LOW_STOCK' | 'SOLD_OUT', { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  IN_STOCK: { label: 'In Stock', tone: 'success' },
  LOW_STOCK: { label: 'Low Stock', tone: 'warning' },
  SOLD_OUT: { label: 'Sold Out', tone: 'neutral' },
};
