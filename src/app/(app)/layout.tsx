import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { FeaturesProvider } from '@/components/features-context';
import { CompanyConfigProvider } from '@/components/company-config-context';
import { isDemoMode } from '@/lib/demo/mode';
import { getBrand } from '@/lib/brand';
import { resolveFeatures } from '@/lib/features';
import { attributeSetOf } from '@/lib/templates';
import { getCurrentUser } from '@/lib/auth/session';
import { countUnread } from '@/lib/services/notification';
import { getMenuForRoles } from '@/lib/services/role-menu';
import { DesktopSidebar } from '@/components/layout/sidebar';
import { MobileNav } from '@/components/layout/mobile-nav';
import { Topbar } from '@/components/layout/topbar';
import { RecentTabs } from '@/components/layout/recent-tabs';
import { PageTransition } from '@/components/layout/page-transition';
import { ShareProvider } from '@/components/share/share-context';
import { DEVELOPER_MENU_MARK } from '@/components/layout/nav-config';
import { isDeveloper } from '@/lib/auth/developer';
import { can } from '@/lib/auth/guards';
import { ALL_PERMISSIONS, PERMISSIONS } from '@/lib/constants';

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

  const [unreadCount, myPages] = await Promise.all([countUnread(user.activeCompany.id), getMenuForRoles(user.roleIds)]);

  // Read the rail's width server-side so the first paint is already correct.
  const sidebarCollapsed = (await cookies()).get('fid_sidebar')?.value === 'collapsed';

  // Only serialisable data crosses into the client components.
  // The developer mark only decides whether the menu lists the developer's page; the page checks for itself.
  // What this person can actually do right now: the permissions they hold, minus
  // any module the company has switched off. An owner holds every permission,
  // so the menu is built from the same list rather than from a "sees all" flag —
  // which is how a switched-off module disappears for the owner too.
  const effective = (user.isSuperAdmin ? ALL_PERMISSIONS : [...user.permissions]).filter((p) => can(user, p));
  const permissions = [...effective, ...(isDeveloper(user) ? [DEVELOPER_MENU_MARK] : [])];
  const companies = user.companies.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    country: c.country,
    localCurrency: c.localCurrency,
    tagline: c.tagline,
  }));
  const features = resolveFeatures(user.activeCompany);

  return (
    <FeaturesProvider features={features}>
    <CompanyConfigProvider
      config={{
        transactionCurrencies: user.activeCompany.transactionCurrencies ?? [],
        salesCurrencies: user.activeCompany.salesCurrencies ?? [],
        defaultSalesCurrency: user.activeCompany.defaultSalesCurrency ?? null,
        terminology: user.activeCompany.terminology ?? {},
        attributeSet: attributeSetOf(user.activeCompany.industryTemplate),
      }}
    >
    <div className="flex min-h-dvh bg-paper">
      {/*
        Without this a keyboard user tabs through every navigation link — more
        than fifty of them — before reaching the first field of a form. For
        someone entering documents all day that is the difference between the
        keyboard being usable and not.
      */}
      <a
        href="#main-content"
        className={[
          // Hidden until focused. The visual styling has to be focus-scoped:
          // padding on the base class overrides sr-only's own `padding: 0` and
          // leaves a small clipped element sitting in the page.
          'sr-only',
          'focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60]',
          'focus:rounded-lg focus:bg-forest-800 focus:px-4 focus:py-2.5',
          'focus:text-sm focus:font-medium focus:text-white focus:shadow-overlay',
        ].join(' ')}
      >
        Skip to main content
      </a>

      <DesktopSidebar
        permissions={permissions}
        isSuperAdmin={false}
        myPages={myPages}
        defaultCollapsed={sidebarCollapsed}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {isDemoMode() ? (
          <div className="bg-forest-950 px-4 py-1.5 text-center text-xs font-medium text-gold-200 print:hidden" data-testid="demo-banner">
            Demonstration — every company, person and figure here is fictional, and the data resets regularly.
          </div>
        ) : null}
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
            country: user.activeCompany.country,
            localCurrency: user.activeCompany.localCurrency,
            tagline: user.activeCompany.tagline,
          }}
          unreadCount={unreadCount}
          permissions={permissions}
        />

        {/* The screens opened lately, one click away. */}
        <RecentTabs userId={user.id} companyId={user.activeCompany.id} />

        {/* The bottom padding clears the mobile tab bar. */}
        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 px-3 pb-24 pt-5 sm:px-5 lg:px-8 lg:pb-10">
          <ShareProvider
            value={{
              company: user.activeCompany.name,
              letterhead: user.activeCompany.letterhead,
              product: getBrand().name,
              userName: user.name,
              canNeverExpire: user.isSuperAdmin || can(user, PERMISSIONS.USERS_MANAGE),
            }}
          >
            <PageTransition>{children}</PageTransition>
          </ShareProvider>
        </main>
      </div>

      <MobileNav permissions={permissions} isSuperAdmin={false} myPages={myPages} />
    </div>
    </CompanyConfigProvider>
    </FeaturesProvider>
  );
}
