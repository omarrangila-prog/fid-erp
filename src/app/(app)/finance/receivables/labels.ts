import type { BadgeTone } from '@/lib/constants';

/** Client-safe copies of the ageing and settlement labels. */
export const AGEING_LABELS_CLIENT: Record<string, string> = {
  CURRENT: 'Current',
  D1_30: '1–30 Days',
  D31_60: '31–60 Days',
  D61_90: '61–90 Days',
  D90_PLUS: '90+ Days',
};

export const SETTLEMENT_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  UNPAID: { label: 'Unpaid', tone: 'danger' },
  PARTIAL: { label: 'Partially paid', tone: 'warning' },
  PAID: { label: 'Paid', tone: 'success' },
};
