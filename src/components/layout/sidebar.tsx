'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NAV_GROUPS, filterNav } from '@/components/layout/nav-config';

/**
 * The navigation is filtered on the client from permission codes rather than
 * being passed pre-rendered, so the icon components never have to cross the
 * server/client boundary. It is a convenience filter only — every route also
 * checks the same permission server-side.
 *
 * Groups collapse, because thirty-odd screens in one unbroken list is a lot to
 * scan when you only ever use six of them. The whole rail collapses too, for
 * people who work in wide tables all day and want the width back.
 */

const SIDEBAR_COOKIE = 'fid_sidebar';

function rememberWidth(collapsed: boolean) {
  // A cookie rather than localStorage so the server renders the right width on
  // the first paint — no flash of the wrong layout on every navigation.
  document.cookie = `${SIDEBAR_COOKIE}=${collapsed ? 'collapsed' : 'expanded'};path=/;max-age=31536000;samesite=lax`;
}

export function SidebarNav({
  permissions,
  isSuperAdmin,
  collapsed = false,
  onNavigate,
}: {
  permissions: string[];
  isSuperAdmin: boolean;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const [closedGroups, setClosedGroups] = React.useState<ReadonlySet<string>>(() => new Set<string>());

  const groups = React.useMemo(
    () => filterNav(NAV_GROUPS, permissions, isSuperAdmin),
    [permissions, isSuperAdmin],
  );

  // Longest-prefix match so /inventory does not light up on /inventory/batches.
  const activeHref = React.useMemo(() => {
    const candidates = groups.flatMap((g) => g.items.map((i) => i.href));
    return candidates
      .filter((c) => pathname === c || pathname.startsWith(`${c}/`))
      .sort((a, b) => b.length - a.length)[0];
  }, [groups, pathname]);

  function toggleGroup(label: string) {
    setClosedGroups((current) => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  return (
    <nav className={cn('flex flex-col gap-1 py-4', collapsed ? 'px-2' : 'px-3')} aria-label="Main">
      {groups.map((group) => {
        const holdsActive = group.items.some((item) => item.href === activeHref);
        const isClosed = !collapsed && closedGroups.has(group.label) && !holdsActive;
        const bodyId = `nav-group-${group.label.replace(/\s+/g, '-').toLowerCase()}`;

        return (
          <div key={group.label} className="pb-2">
            {collapsed ? (
              <div className="mx-auto mb-1 h-px w-6 bg-line-strong" aria-hidden />
            ) : (
              <button
                type="button"
                onClick={() => toggleGroup(group.label)}
                aria-expanded={!isClosed}
                aria-controls={bodyId}
                className="flex w-full items-center gap-1 rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-subtle transition-colors hover:text-ink"
              >
                <ChevronRight
                  className={cn('size-3 shrink-0 transition-transform', !isClosed && 'rotate-90')}
                  aria-hidden
                />
                <span className="truncate">{group.label}</span>
              </button>
            )}

            <ul id={bodyId} className={cn('space-y-0.5', isClosed && 'hidden')}>
              {group.items.map((item) => {
                const active = item.href === activeHref;
                const Icon = item.icon;
                return (
                  <li key={item.href} className="relative">
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      title={collapsed ? item.label : undefined}
                      className={cn(
                        'group/nav relative flex items-center rounded-lg py-2 text-sm transition-colors',
                        collapsed ? 'justify-center px-2' : 'gap-2.5 pl-3 pr-3',
                        active
                          ? 'bg-forest-50 font-medium text-forest-800'
                          : 'text-ink-muted hover:bg-forest-50/70 hover:text-ink',
                      )}
                    >
                      {active ? (
                        <span
                          className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-gold-600"
                          aria-hidden
                        />
                      ) : null}
                      <Icon className={cn('size-4 shrink-0', active ? 'text-forest-700' : 'text-ink-subtle')} />
                      {collapsed ? (
                        <span className="sr-only">{item.label}</span>
                      ) : (
                        <span className="truncate">{item.label}</span>
                      )}

                      {/* Collapsed rail: a real label on hover, not just a native tooltip delay. */}
                      {collapsed ? (
                        <span
                          role="presentation"
                          className="pointer-events-none absolute left-full z-50 ml-2 hidden whitespace-nowrap rounded-md bg-forest-900 px-2 py-1 text-xs font-medium text-white shadow-overlay group-hover/nav:block"
                        >
                          {item.label}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

export function DesktopSidebar({
  permissions,
  isSuperAdmin,
  defaultCollapsed = false,
}: {
  permissions: string[];
  isSuperAdmin: boolean;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed);

  function toggle() {
    setCollapsed((current) => {
      rememberWidth(!current);
      return !current;
    });
  }

  return (
    <aside
      className={cn(
        'hidden shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-200 lg:flex',
        collapsed ? 'w-[4.25rem]' : 'w-64',
      )}
    >
      <div
        className={cn(
          'flex h-14 shrink-0 items-center border-b border-line',
          collapsed ? 'justify-center px-2' : 'gap-2.5 px-5',
        )}
      >
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-forest-800 text-xs font-bold text-white">
          FID
        </div>
        {collapsed ? null : (
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">FID Trading</p>
            <p className="truncate text-[11px] text-ink-subtle">Business Management</p>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <SidebarNav permissions={permissions} isSuperAdmin={isSuperAdmin} collapsed={collapsed} />
      </div>

      <div className="shrink-0 border-t border-line p-2">
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
          title={collapsed ? 'Expand' : 'Collapse'}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-muted transition-colors hover:bg-forest-50 hover:text-ink',
            collapsed && 'justify-center px-2',
          )}
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          {collapsed ? null : <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
