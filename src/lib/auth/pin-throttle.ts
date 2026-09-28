import 'server-only';
import { prisma } from '@/lib/db';

/**
 * Making PIN guessing slow.
 *
 * A four-digit PIN is ten thousand possibilities, and with PIN-only sign-in a
 * guess is tried against everybody at once. What keeps that safe is how few
 * guesses anyone gets:
 *
 *   - five wrong PINs from one device, or one network address, in fifteen
 *     minutes, and that device or address is refused for the rest of the
 *     window — even the right PIN, so the block gives nothing away;
 *   - past sixty wrong PINs in fifteen minutes from anywhere, PIN sign-in
 *     pauses for everyone until the window clears: someone is working through
 *     the list from many addresses;
 *   - every wrong PIN also waits a second before answering.
 *
 * The count lives in the audit trail, not in memory: the application runs on
 * several server instances at once, and an in-memory counter per instance
 * would multiply the guesses allowed by however many instances there are.
 * Each failure is also the record the owner reads: when, from where, on what.
 */

export const PIN_WINDOW_MINUTES = 15;
export const PIN_FAILURES_PER_SOURCE = 5;
export const PIN_FAILURES_GLOBAL = 60;
const FAILURE_DELAY_MS = 1000;

export const PIN_FAILED_ACTION = 'PIN_LOGIN_FAILED';

export type PinSource = { address: string | null; device: string; userAgent: string | null };

export type ThrottleVerdict = { blocked: false } | { blocked: true; retryAfterMinutes: number };

export async function checkPinThrottle(source: PinSource): Promise<ThrottleVerdict> {
  const since = new Date(Date.now() - PIN_WINDOW_MINUTES * 60_000);
  const bySource = [{ entityType: 'LoginDevice', entityId: source.device }, ...(source.address ? [{ ipAddress: source.address }] : [])];
  const [mine, everyone] = await Promise.all([
    prisma.auditLog.findMany({
      where: { action: PIN_FAILED_ACTION, createdAt: { gte: since }, OR: bySource },
      select: { createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: PIN_FAILURES_PER_SOURCE,
    }),
    prisma.auditLog.count({ where: { action: PIN_FAILED_ACTION, createdAt: { gte: since } } }),
  ]);

  const waitFrom = (oldest: Date) =>
    Math.max(1, Math.ceil((oldest.getTime() + PIN_WINDOW_MINUTES * 60_000 - Date.now()) / 60_000));
  if (mine.length >= PIN_FAILURES_PER_SOURCE) {
    return { blocked: true, retryAfterMinutes: waitFrom(mine[mine.length - 1].createdAt) };
  }
  if (everyone >= PIN_FAILURES_GLOBAL) return { blocked: true, retryAfterMinutes: PIN_WINDOW_MINUTES };
  return { blocked: false };
}

/** A wrong PIN: recorded with when, where and on what, then answered slowly. */
export async function recordPinFailure(source: PinSource, reason: 'WRONG_PIN' | 'SHARED_PIN' | 'BLOCKED'): Promise<void> {
  await prisma.auditLog.create({
    data: {
      companyId: null,
      userId: null,
      action: reason === 'BLOCKED' ? 'PIN_LOGIN_BLOCKED' : PIN_FAILED_ACTION,
      entityType: 'LoginDevice',
      entityId: source.device,
      after: { reason },
      ipAddress: source.address,
      userAgent: source.userAgent?.slice(0, 500) ?? null,
    },
  });
  if (reason !== 'BLOCKED') await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
}
