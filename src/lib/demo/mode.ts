/**
 * Demo mode: a deployment that exists to be looked at.
 *
 * Switched on by `DEMO_MODE=1` on a deployment whose database holds only the
 * fictional demo customer. It adds a one-click "Explore the demo" sign-in, a
 * banner, and takes away the few things that would let a visitor damage the
 * demonstration for the next one: people, roles, companies and backups. It is
 * never on for a real customer's deployment.
 */
import { PERMISSIONS, type PermissionCode } from '@/lib/constants';

export const isDemoMode = () => process.env.DEMO_MODE === '1';

export const DEMO_USER_EMAIL = () => process.env.DEMO_USER_EMAIL ?? 'demo@demo.example';

const BLOCKED: ReadonlySet<PermissionCode> = new Set([
  PERMISSIONS.USERS_MANAGE,
  PERMISSIONS.ROLES_MANAGE,
  PERMISSIONS.COMPANIES_MANAGE,
  PERMISSIONS.BACKUP_MANAGE,
]);

export const demoBlocks = (permission: PermissionCode) => isDemoMode() && BLOCKED.has(permission);
