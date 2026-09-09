import 'server-only';

/**
 * Login throttling.
 *
 * Guards against someone working through a password list against a known
 * address. Attempts are counted per email and per client address separately,
 * so one attacker cannot lock out a legitimate user by hammering their email
 * from elsewhere: the address limit bites first.
 *
 * The store is in memory, which means it is per server process. That is honest
 * protection for a single-instance deployment and no protection at all across
 * a horizontally scaled one — behind more than one instance this belongs in
 * Redis or a table. It is deliberately not silently pretending otherwise.
 */

type Attempt = { count: number; firstAt: number; blockedUntil: number };

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_EMAIL = 8;
const MAX_PER_ADDRESS = 25;
const BLOCK_MS = 15 * 60 * 1000;

const attempts = new Map<string, Attempt>();

/** Drops entries whose window has passed, so the map cannot grow unbounded. */
function sweep(now: number): void {
  if (attempts.size < 500) return;
  for (const [key, attempt] of attempts) {
    if (now > attempt.blockedUntil && now - attempt.firstAt > WINDOW_MS) {
      attempts.delete(key);
    }
  }
}

function check(key: string, limit: number, now: number): number | null {
  const attempt = attempts.get(key);
  if (!attempt) return null;
  if (now < attempt.blockedUntil) return Math.ceil((attempt.blockedUntil - now) / 1000);
  if (now - attempt.firstAt > WINDOW_MS) {
    attempts.delete(key);
    return null;
  }
  return attempt.count >= limit ? Math.ceil((attempt.blockedUntil - now) / 1000) : null;
}

export type RateLimitVerdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Called before the password is checked. */
export function checkLoginAllowed(email: string, address: string): RateLimitVerdict {
  const now = Date.now();
  sweep(now);

  const byEmail = check(`email:${email}`, MAX_PER_EMAIL, now);
  const byAddress = check(`addr:${address}`, MAX_PER_ADDRESS, now);
  const wait = Math.max(byEmail ?? 0, byAddress ?? 0);

  return wait > 0 ? { allowed: false, retryAfterSeconds: wait } : { allowed: true };
}

/** Called after a failed attempt. */
export function recordFailedLogin(email: string, address: string): void {
  const now = Date.now();
  for (const [key, limit] of [
    [`email:${email}`, MAX_PER_EMAIL],
    [`addr:${address}`, MAX_PER_ADDRESS],
  ] as const) {
    const existing = attempts.get(key);
    if (!existing || now - existing.firstAt > WINDOW_MS) {
      attempts.set(key, { count: 1, firstAt: now, blockedUntil: 0 });
      continue;
    }
    existing.count += 1;
    if (existing.count >= limit) {
      existing.blockedUntil = now + BLOCK_MS;
    }
  }
}

/** Called after a successful sign-in, so a good password clears the slate. */
export function clearLoginAttempts(email: string, address: string): void {
  attempts.delete(`email:${email}`);
  attempts.delete(`addr:${address}`);
}

/** Test seam. */
export function resetLoginThrottle(): void {
  attempts.clear();
}
