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
  // Groups behave as dropdowns: shut until asked for. The section you are
  // working in opens itself, so the rail shows where you are without
  // presenting forty links at once.
  const [openedGroups, setOpenedGroups] = React.useState<ReadonlySet<string>>(() => new Set<string>());

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
    setOpenedGroups((current) => {
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
        // The group you are inside is always open; the rail is all icons when
        // collapsed, so grouping does not apply there.
        const isOpen = collapsed || holdsActive || openedGroups.has(group.label);
        const bodyId = `nav-group-${group.label.replace(/\s+/g, '-').toLowerCase()}`;
        const count = group.items.length;

        return (
          <div key={group.label} className="pb-2">
            {collapsed ? (
              <div className="mx-auto mb-1 h-px w-6 bg-forest-700" aria-hidden />
            ) : (
              <button
                type="button"
                onClick={() => toggleGroup(group.label)}
                aria-expanded={isOpen}
                aria-controls={bodyId}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-md px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wider transition-colors',
                  holdsActive ? 'text-gold-300' : 'text-forest-300 hover:bg-forest-800/60 hover:text-forest-100',
                )}
              >
                <ChevronRight
                  className={cn('size-3.5 shrink-0 transition-transform', isOpen && 'rotate-90')}
                  aria-hidden
                />
                <span className="flex-1 truncate text-left">{group.label}</span>
                {!isOpen ? (
                  <span className="tnum rounded-full bg-forest-800 px-1.5 text-[11px] font-medium text-forest-300">
                    {count}
                  </span>
                ) : null}
              </button>
            )}

            <ul id={bodyId} className={cn('space-y-0.5', !isOpen && 'hidden')}>
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
                        collapsed ? 'justify-center px-2' : 'gap-2.5 pl-5 pr-3',
                        active
                          ? 'bg-forest-800 font-medium text-white'
                          : 'text-forest-200 hover:bg-forest-800/60 hover:text-white',
                      )}
                    >
                      {active ? (
                        <span
                          className="absolute inset-y-1 left-0 w-[3px] rounded-r bg-gold-400"
                          aria-hidden
                        />
                      ) : null}
                      <Icon className={cn('size-4 shrink-0', active ? 'text-gold-300' : 'text-forest-300')} />
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
        'hidden shrink-0 flex-col border-r border-forest-950 bg-forest-900 transition-[width] duration-200 lg:flex',
        collapsed ? 'w-[4.25rem]' : 'w-64',
      )}
    >
      <div
        className={cn(
          'flex h-[4.5rem] shrink-0 items-center border-b border-forest-800',
          collapsed ? 'justify-center px-2' : 'gap-2.5 px-5',
        )}
      >
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-gold-500 text-sm font-bold tracking-tight text-forest-950">
          FID
        </div>
        {collapsed ? null : (
          <div className="min-w-0">
            <p className="truncate text-base font-semibold tracking-tight text-white">FID Trading</p>
            <p className="truncate text-[11px] tracking-[0.18em] text-gold-300">TRADING</p>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <SidebarNav permissions={permissions} isSuperAdmin={isSuperAdmin} collapsed={collapsed} />
      </div>

      <div className="shrink-0 border-t border-forest-800 p-2">
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
          title={collapsed ? 'Expand' : 'Collapse'}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-forest-300 transition-colors hover:bg-forest-800 hover:text-white',
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
