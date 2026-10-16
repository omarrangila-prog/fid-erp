import { FEATURES, type Feature } from '@/lib/features';

/**
 * What a product plan allows — the one place a limit or a plan-gated feature is
 * decided. No plan check appears anywhere else in the code; screens and
 * services call `planAllows` / `planLimit` and nothing more. Billing is not
 * built: a plan is a name on the Organization that this table interprets.
 */

export type Limits = {
  users: number;
  companies: number;
  warehouses: number;
  /** Posted documents per calendar month; the cheapest proxy for usage. */
  monthlyTransactions: number;
  storageMb: number;
};

export type Plan = {
  key: string;
  label: string;
  /** Features this plan can ever switch on. */
  features: ReadonlyArray<Feature>;
  limits: Limits;
  apiAccess: boolean;
};

const UNLIMITED = Number.MAX_SAFE_INTEGER;
const without = (...off: Feature[]) => FEATURES.filter((f) => !off.includes(f));

export const PLANS: Record<string, Plan> = {
  STARTER: {
    key: 'STARTER',
    label: 'Starter',
    features: without('MULTI_COMPANY', 'WHATSAPP_SHARING', 'CUSTOM_REPORTS', 'ADVANCED_ACCOUNTING'),
    limits: { users: 3, companies: 1, warehouses: 2, monthlyTransactions: 300, storageMb: 500 },
    apiAccess: false,
  },
  GROWTH: {
    key: 'GROWTH',
    label: 'Growth',
    features: without('MULTI_COMPANY'),
    limits: { users: 10, companies: 1, warehouses: 10, monthlyTransactions: 3000, storageMb: 5000 },
    apiAccess: false,
  },
  ENTERPRISE: {
    key: 'ENTERPRISE',
    label: 'Enterprise',
    features: FEATURES,
    limits: { users: UNLIMITED, companies: UNLIMITED, warehouses: UNLIMITED, monthlyTransactions: UNLIMITED, storageMb: UNLIMITED },
    apiAccess: true,
  },
};

export function planFor(key: string | null | undefined): Plan {
  return PLANS[key ?? ''] ?? PLANS.ENTERPRISE;
}

export function planAllows(planKey: string | null | undefined, feature: Feature): boolean {
  return planFor(planKey).features.includes(feature);
}

export function planLimit(planKey: string | null | undefined, limit: keyof Limits): number {
  return planFor(planKey).limits[limit];
}
