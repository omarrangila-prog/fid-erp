import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';

/**
 * The bare domain.
 *
 * Nobody types /login or /dashboard; they type the address they were given.
 * Without this the root returned a 404, which reads as "the site is broken"
 * rather than "you are not signed in".
 */
export const dynamic = 'force-dynamic';

export default async function RootPage() {
  const user = await getCurrentUser();
  redirect(user ? '/dashboard' : '/login');
}
