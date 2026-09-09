import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkLoginAllowed, recordFailedLogin, clearLoginAttempts, resetLoginThrottle,
} from '@/lib/auth/rate-limit';

describe('login throttling', () => {
  beforeEach(() => resetLoginThrottle());

  it('allows a first attempt', () => {
    expect(checkLoginAllowed('a@example.com', '1.1.1.1').allowed).toBe(true);
  });

  it('blocks an email after repeated failures', () => {
    for (let i = 0; i < 8; i++) recordFailedLogin('a@example.com', '1.1.1.1');
    const verdict = checkLoginAllowed('a@example.com', '1.1.1.1');
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('does not block a different account from a different address', () => {
    for (let i = 0; i < 8; i++) recordFailedLogin('a@example.com', '1.1.1.1');
    expect(checkLoginAllowed('b@example.com', '2.2.2.2').allowed).toBe(true);
  });

  it('clears the count once the password is right', () => {
    for (let i = 0; i < 5; i++) recordFailedLogin('a@example.com', '1.1.1.1');
    clearLoginAttempts('a@example.com', '1.1.1.1');
    for (let i = 0; i < 5; i++) recordFailedLogin('a@example.com', '1.1.1.1');
    expect(checkLoginAllowed('a@example.com', '1.1.1.1').allowed).toBe(true);
  });

  it('eventually blocks one address spraying many accounts', () => {
    for (let i = 0; i < 25; i++) recordFailedLogin(`user${i}@example.com`, '9.9.9.9');
    expect(checkLoginAllowed('fresh@example.com', '9.9.9.9').allowed).toBe(false);
  });
});
