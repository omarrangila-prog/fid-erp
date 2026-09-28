import 'server-only';
import { prisma } from '@/lib/db';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { BusinessRuleError, ConflictError } from '@/lib/errors';

/**
 * PIN sign-in: the PIN alone says who you are.
 *
 * The client wants one thing on the sign-in screen — a four-digit PIN. So the
 * PIN is the credential and the identifier at once, and two rules follow:
 *
 *   - Every PIN belongs to one person. Setting a PIN another account already
 *     has is refused, so a PIN can never open somebody else's permissions.
 *   - PINs are stored only as Argon2id hashes. A salted hash cannot be looked
 *     up, so signing in checks the PIN against each account that has one —
 *     a handful of people, a few milliseconds each — and the digits are never
 *     kept, shown or logged anywhere.
 *
 * Ten thousand possibilities are few, so guessing is made expensive elsewhere:
 * failed attempts are counted per device and per address, and globally, in
 * the audit trail (`pin-throttle.ts`), where every Vercel instance sees them.
 */

export const PIN_TAKEN_MESSAGE = 'This PIN is already assigned. Please choose another PIN.';

export function validatePinFormat(pin: string): string | null {
  if (!/^\d{4}$/.test(pin)) return 'A PIN is exactly four digits.';
  if (/^(\d)\1{3}$/.test(pin)) return 'Choose a PIN that is not the same digit four times.';
  if (['1234', '4321', '0123', '9876'].includes(pin)) {
    return 'That PIN is too easy to guess. Choose another.';
  }
  return null;
}

/** Every account whose PIN is this one — disabled accounts included, so re-enabling one can never create a clash. */
async function ownersOf(pin: string, activeOnly: boolean): Promise<string[]> {
  const candidates = await prisma.user.findMany({
    where: { pinHash: { not: null }, ...(activeOnly ? { isActive: true } : {}) },
    select: { id: true, pinHash: true },
  });
  // Every hash is checked, match or not, so the time taken says nothing about which one matched.
  const checks = await Promise.all(candidates.map(async (c) => ((await verifyPassword(c.pinHash!, pin)) ? c.id : null)));
  return checks.filter((id): id is string => id !== null);
}

export async function isPinTaken(pin: string, exceptUserId?: string | null): Promise<boolean> {
  return (await ownersOf(pin, false)).some((id) => id !== exceptUserId);
}

/** Sets or changes a user's PIN. The old one stops working at once. */
export async function setPin(userId: string, pin: string): Promise<void> {
  const problem = validatePinFormat(pin);
  if (problem) throw new BusinessRuleError(problem);
  if (await isPinTaken(pin, userId)) throw new ConflictError(PIN_TAKEN_MESSAGE);

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

export async function clearPin(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { pinHash: null, pinSetAt: null, pinFailedAttempts: 0, pinLockedUntil: null },
  });
}

export type PinIdentity =
  | { ok: true; userId: string }
  | { ok: false; reason: 'INVALID' | 'AMBIGUOUS'; userIds?: string[] };

/**
 * Who this PIN belongs to, among active accounts.
 *
 * Exactly one match signs that person in. None is a wrong PIN. More than one
 * can only be left over from before PINs had to be unique; nobody is signed
 * in, because guessing between two people is how the wrong name ends up on a
 * posting.
 */
export async function identifyByPin(pin: string): Promise<PinIdentity> {
  if (!/^\d{4}$/.test(pin)) return { ok: false, reason: 'INVALID' };
  const owners = await ownersOf(pin, true);
  if (owners.length === 1) return { ok: true, userId: owners[0] };
  if (owners.length > 1) return { ok: false, reason: 'AMBIGUOUS', userIds: owners };
  return { ok: false, reason: 'INVALID' };
}

/** Whether anyone can sign in with a PIN yet; a brand-new installation starts with a password. */
export async function anyPinAccount(): Promise<boolean> {
  return (await prisma.user.count({ where: { isActive: true, pinHash: { not: null } } })) > 0;
}
