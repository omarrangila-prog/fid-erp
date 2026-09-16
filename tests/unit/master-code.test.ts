import { describe, expect, it } from 'vitest';
import { resolveMasterCode } from '@/lib/services/master-code';

describe('resolveMasterCode', () => {
  it('issues a new code when creating and the form left the field blank', () => {
    expect(resolveMasterCode({ submitted: null, isCreate: true })).toEqual({ generate: true });
    expect(resolveMasterCode({ submitted: '', isCreate: true })).toEqual({ generate: true });
  });

  it('keeps a code the user typed on create', () => {
    expect(resolveMasterCode({ submitted: 'CUS-42', isCreate: true })).toEqual({ code: 'CUS-42' });
  });

  it('keeps the existing code when an edit form omits it', () => {
    expect(
      resolveMasterCode({ submitted: null, existing: 'CUS-0001', isCreate: false }),
    ).toEqual({ code: 'CUS-0001' });
    expect(
      resolveMasterCode({ submitted: '', existing: 'SUP-0003', isCreate: false }),
    ).toEqual({ code: 'SUP-0003' });
  });

  it('lets an edit rename the code when one is submitted', () => {
    expect(
      resolveMasterCode({ submitted: 'CUS-0099', existing: 'CUS-0001', isCreate: false }),
    ).toEqual({ code: 'CUS-0099' });
  });
});
