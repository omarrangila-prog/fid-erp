import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { countUnread } from '@/lib/services/notification';
import { DesktopSidebar } from '@/components/layout/sidebar';
import { MobileNav } from '@/components/layout/mobile-nav';
import { Topbar } from '@/components/layout/topbar';

/**
 * The authenticated shell.
 *
 * Every page beneath this layout is guaranteed a signed-in user with at least
 * one accessible company. Individual pages still assert their own permission —
 * this guard is about authentication and company context, not authorisation.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const unreadCount = await countUnread(user.activeCompany.id);

  // Read the rail's width server-side so the first paint is already correct.
  const sidebarCollapsed = (await cookies()).get('fid_sidebar')?.value === 'collapsed';

  // Only serialisable data crosses into the client components.
  const permissions = [...user.permissions];
  const companies = user.companies.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    localCurrency: c.localCurrency,
  }));

  return (
    <div className="flex min-h-dvh bg-paper">
      <DesktopSidebar
        permissions={permissions}
        isSuperAdmin={user.isSuperAdmin}
        defaultCollapsed={sidebarCollapsed}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          user={{
            id: user.id,
            name: user.name,
            email: user.email,
            roleNames: user.roleNames,
            isSuperAdmin: user.isSuperAdmin,
          }}
          companies={companies}
          activeCompany={{
            id: user.activeCompany.id,
            code: user.activeCompany.code,
            name: user.activeCompany.name,
            localCurrency: user.activeCompany.localCurrency,
          }}
          unreadCount={unreadCount}
          permissions={permissions}
        />

        {/* The bottom padding clears the mobile tab bar. */}
        <main className="min-w-0 flex-1 px-3 pb-24 pt-5 sm:px-5 lg:px-8 lg:pb-10">
          <div className="mx-auto w-full max-w-[100rem]">{children}</div>
        </main>
      </div>

      <MobileNav permissions={permissions} isSuperAdmin={user.isSuperAdmin} />
    </div>
  );
}
