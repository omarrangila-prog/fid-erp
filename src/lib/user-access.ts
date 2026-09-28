/**
 * What one person may do beyond their role, and whose data they see.
 *
 * Kept in the settings table, one key each per user, so no new tables were
 * needed:
 *
 *   user_permissions:<userId>   { grant: [...], revoke: [...] }
 *       The owner's changes for this one person, on top of the role: a tick
 *       the role lacks is granted; a tick the role has and the owner removed
 *       is revoked. Final permission = role + grants − revokes.
 *
 *   user_scope:<userId>         { agentId, warehouseIds }
 *       An agent signing in for himself: his own agent record, and the
 *       warehouses he may see. Pages and actions narrow their data to these,
 *       on the server.
 *
 * Pure helpers only; reading and writing happen in the session and the admin
 * actions.
 */

export type PermissionOverrides = { grant: string[]; revoke: string[] };
export type UserScope = { agentId: string | null; warehouseIds: string[] };

export const NO_OVERRIDES: PermissionOverrides = { grant: [], revoke: [] };
export const NO_SCOPE: UserScope = { agentId: null, warehouseIds: [] };

export const permissionsKey = (userId: string) => `user_permissions:${userId}`;
export const scopeKey = (userId: string) => `user_scope:${userId}`;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string' && v.length > 0))] : [];

export function parseOverrides(value: string | null | undefined): PermissionOverrides {
  if (!value) return NO_OVERRIDES;
  try {
    const parsed = JSON.parse(value) as { grant?: unknown; revoke?: unknown };
    return { grant: strings(parsed.grant), revoke: strings(parsed.revoke) };
  } catch {
    return NO_OVERRIDES;
  }
}

export function parseScope(value: string | null | undefined): UserScope {
  if (!value) return NO_SCOPE;
  try {
    const parsed = JSON.parse(value) as { agentId?: unknown; warehouseIds?: unknown };
    return {
      agentId: typeof parsed.agentId === 'string' && parsed.agentId ? parsed.agentId : null,
      warehouseIds: strings(parsed.warehouseIds),
    };
  } catch {
    return NO_SCOPE;
  }
}

/** Role permissions with this person's grants added and revokes removed. */
export function applyOverrides<T extends string>(role: Iterable<T>, overrides: PermissionOverrides, known: ReadonlySet<string>): Set<T> {
  const result = new Set<T>(role);
  for (const code of overrides.grant) if (known.has(code)) result.add(code as T);
  for (const code of overrides.revoke) result.delete(code as T);
  return result;
}

/** The overrides that turn a role's permissions into the ones wanted for one person. */
export function overridesFor(role: Iterable<string>, wanted: Iterable<string>): PermissionOverrides {
  const base = new Set(role);
  const target = new Set(wanted);
  return {
    grant: [...target].filter((code) => !base.has(code)).sort(),
    revoke: [...base].filter((code) => !target.has(code)).sort(),
  };
}
