import 'server-only';
import { prisma } from '@/lib/db';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { BusinessRuleError } from '@/lib/errors';

/**
 * Quick PIN sign-in.
 *
 * A four-digit PIN is 10,000 possibilities, so the only thing making it safe is
 * that guessing is expensive. Three defences do that work:
 *
 *   - the PIN is stored as an Argon2id hash, never as the digits;
 *   - five wrong attempts lock the PIN for fifteen minutes, and the lock is
 *     per user, so one person's fumbling cannot lock out the office;
 *   - a locked PIN does not lock the account — password sign-in still works,
 *     which is what stops a lockout becoming a lost afternoon.
 *
 * Every PIN belongs to exactly one person. It carries that person's roles and
 * companies and nobody else's, so the audit trail still names an individual.
 */

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export function validatePinFormat(pin: string): string | null {
  if (!/^\d{4}$/.test(pin)) return 'A PIN is exactly four digits.';
  if (/^(\d)\1{3}$/.test(pin)) return 'Choose a PIN that is not the same digit four times.';
  if (['1234', '4321', '0123', '9876'].includes(pin)) {
    return 'That PIN is too easy to guess. Choose another.';
  }
  return null;
}

export async function setPin(userId: string, pin: string): Promise<void> {
  const problem = validatePinFormat(pin);
  if (problem) throw new BusinessRuleError(problem);

  await prisma.user.update({
    where: { id: userId },
    data: {
      pinHash: await hashPassword(pin),
      pinSetAt: new Date(),
      pinFailedAttempts: 0,
      pinLockedUntil: null,
    },
  });
}

/**
 * Sets a PIN without the weak-PIN check.
 *
 * Only for initialisation, where the operator has chosen the codes deliberately
 * and knowingly. Anything a user picks inside the application goes through
 * `setPin`, which refuses the obvious ones.
 */
export async function setPinUnchecked(userId: string, pin: string): Promise<void> {
  if (!/^\d{4}$/.test(pin)) throw new BusinessRuleError('A PIN is exactly four digits.');
  await prisma.user.update({
    where: { id: userId },
    data: { pinHash: await hashPassword(pin), pinSetAt: new Date(), pinFailedAttempts: 0, pinLockedUntil: null },
  });
}

export async function clearPin(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { pinHash: null, pinSetAt: null, pinFailedAttempts: 0, pinLockedUntil: null },
  });
}

export type PinResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'INVALID' | 'LOCKED' | 'NO_PIN'; retryAfterMinutes?: number };

/**
 * Checks a PIN against one named user.
 *
 * The user is identified first — by the account they picked on screen — so a
 * PIN can never grant somebody else's permissions by colliding with theirs.
 */
export async function verifyPin(userId: string, pin: string): Promise<PinResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, pinHash: true, pinFailedAttempts: true, pinLockedUntil: true, isActive: true },
  });

  if (!user || !user.isActive || !user.pinHash) {
    return { ok: false, reason: 'NO_PIN' };
  }

  if (user.pinLockedUntil && user.pinLockedUntil.getTime() > Date.now()) {
    return {
      ok: false,
      reason: 'LOCKED',
      retryAfterMinutes: Math.ceil((user.pinLockedUntil.getTime() - Date.now()) / 60_000),
    };
  }

  if (await verifyPassword(user.pinHash, pin)) {
    if (user.pinFailedAttempts > 0 || user.pinLockedUntil) {
      await prisma.user.update({
        where: { id: user.id },
        data: { pinFailedAttempts: 0, pinLockedUntil: null },
      });
    }
    return { ok: true, userId: user.id };
  }

  const attempts = user.pinFailedAttempts + 1;
  const locked = attempts >= MAX_ATTEMPTS;
  await prisma.user.update({
    where: { id: user.id },
    data: {
      pinFailedAttempts: locked ? 0 : attempts,
      pinLockedUntil: locked ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
    },
  });

  return locked
    ? { ok: false, reason: 'LOCKED', retryAfterMinutes: LOCK_MINUTES }
    : { ok: false, reason: 'INVALID' };
}

/**
 * The accounts offered on the PIN screen.
 *
 * Only people who have set a PIN appear, and only their name, role and company
 * — never an email address, which would hand a stranger half of a password
 * login for free.
 */
export async function listPinAccounts() {
  const users = await prisma.user.findMany({
    where: { isActive: true, pinHash: { not: null } },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      isSuperAdmin: true,
      roles: { select: { role: { select: { name: true } } } },
      companies: { select: { company: { select: { name: true, country: true, code: true } } } },
    },
  });

  const allCompanies = await prisma.company.findMany({
    where: { status: 'ACTIVE' },
    select: { name: true, country: true, code: true },
    orderBy: { name: 'asc' },
  });

  return users.map((user) => {
    const companies = user.isSuperAdmin ? allCompanies : user.companies.map((c) => c.company);
    return {
      id: user.id,
      name: user.name,
      role: user.isSuperAdmin ? 'Administrator' : (user.roles[0]?.role.name ?? 'No role'),
      companies: companies.map((c) => ({ name: c.name, country: c.country, code: c.code })),
    };
  });
}
