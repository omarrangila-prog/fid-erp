import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id parameters. These follow the OWASP password-storage cheat-sheet
 * recommendation (19 MiB memory, 2 iterations, parallelism 1) which is a good
 * balance for a Node server handling interactive logins.
 */
const ARGON_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON_OPTIONS);
}

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain, ARGON_OPTIONS);
  } catch {
    // A malformed or truncated hash must read as "wrong password", never as a crash.
    return false;
  }
}

/** Minimum password policy enforced on creation and reset. */
export function validatePasswordStrength(password: string): string | null {
  if (password.length < 10) return 'Password must be at least 10 characters long.';
  if (!/[a-z]/.test(password)) return 'Password must contain a lowercase letter.';
  if (!/[A-Z]/.test(password)) return 'Password must contain an uppercase letter.';
  if (!/[0-9]/.test(password)) return 'Password must contain a number.';
  return null;
}
