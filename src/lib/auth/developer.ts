import 'server-only';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser, type SessionUser } from '@/lib/auth/session';

/**
 * The developer: whoever the deployment names in DEVELOPER_USERS — user ids
 * or email addresses, comma-separated.
 *
 * It is a setting of the server, not a permission. A permission can be given
 * from the Roles screen by anybody who manages users, owner included; the
 * share-activity log is, at the client's request, for the developer only, so
 * nothing inside the application can grant it. Unset means nobody.
 */
function developerList(): Set<string> {
  return new Set(
    (process.env.DEVELOPER_USERS ?? '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isDeveloper(user: Pick<SessionUser, 'id' | 'email'>): boolean {
  const list = developerList();
  return list.has(user.id.toLowerCase()) || list.has(user.email.toLowerCase());
}

/**
 * For the developer's pages: anybody else gets the ordinary "not found", so
 * the page does not even confirm that it exists.
 */
export async function requireDeveloperPage(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!isDeveloper(user)) notFound();
  return user;
}
