import { describe, expect, it } from 'vitest';
import { FEATURES } from '@/lib/features';
import { PLAN_FEATURES } from '@/lib/entitlements';

describe('feature lists', () => {
  it('the entitlements copy of the feature list matches features.ts exactly', () => {
    expect([...PLAN_FEATURES].sort()).toEqual([...FEATURES].sort());
  });
});
