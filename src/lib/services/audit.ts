import type { Tx } from '@/lib/db';
import { prisma } from '@/lib/db';

export type AuditInput = {
  companyId?: string | null;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * Values are stored as JSON. Decimals and Dates are not JSON-native, so they
 * are normalised to strings first — otherwise Prisma rejects the payload and a
 * business transaction would fail because of its own audit trail.
 */
function normalise(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (typeof (value as { toFixed?: unknown }).toFixed === 'function' && 'd' in (value as object)) {
      return String(value); // Prisma Decimal
    }
    if (Array.isArray(value)) return value.map(normalise);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'passwordHash' || k === 'token') continue; // never audit secrets
      out[k] = normalise(v);
    }
    return out;
  }
  return value;
}

/** Writes an audit row inside an existing transaction. */
export async function writeAudit(tx: Tx, input: AuditInput): Promise<void> {
  await tx.auditLog.create({
    data: {
      companyId: input.companyId ?? null,
      userId: input.userId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: input.before === undefined ? undefined : (normalise(input.before) as never),
      after: input.after === undefined ? undefined : (normalise(input.after) as never),
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
}

/**
 * Writes an audit row outside a transaction. Used for events that are not part
 * of a business posting (login, logout, company switch). Never throws: an audit
 * failure must not break a user's sign-in.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await writeAudit(prisma as unknown as Tx, input);
  } catch (error) {
    console.error('[audit] failed to write audit log', error);
  }
}
