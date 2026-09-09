'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NAV_GROUPS, filterNav } from '@/components/layout/nav-config';

/**
 * The navigation is filtered on the client from permission codes rather than
 * being passed pre-rendered, so the icon components never have to cross the
 * server/client boundary. It is a convenience filter only — every route also
 * checks the same permission server-side.
 *
 * Groups collapse, because thirty-odd screens in one unbroken list is a lot to
 * scan when you only ever use six of them.
 */
export function SidebarNav({
  permissions,
  isSuperAdmin,
  onNavigate,
}: {
  permissions: string[];
  isSuperAdmin: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set<string>());

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
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  return (
    <nav className="flex flex-col gap-1 px-3 py-4">
      {groups.map((group) => {
        // A collapsed group still opens itself when you are inside it.
        const holdsActive = group.items.some((item) => item.href === activeHref);
        const isCollapsed = collapsed.has(group.label) && !holdsActive;
        const bodyId = `nav-group-${group.label.replace(/\s+/g, '-').toLowerCase()}`;

        return (
          <div key={group.label} className="pb-2">
            <button
              type="button"
              onClick={() => toggleGroup(group.label)}
              aria-expanded={!isCollapsed}
              aria-controls={bodyId}
              className="flex w-full items-center gap-1 rounded-md px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-navy-400 transition-colors hover:text-navy-200"
            >
              <ChevronRight
                className={cn('size-3 shrink-0 transition-transform', !isCollapsed && 'rotate-90')}
                aria-hidden
              />
              <span className="truncate">{group.label}</span>
            </button>

            <ul id={bodyId} className={cn('space-y-0.5', isCollapsed && 'hidden')}>
              {group.items.map((item) => {
                const active = item.href === activeHref;
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'relative flex items-center gap-2.5 rounded-lg py-2 pl-3 pr-3 text-sm transition-colors',
                        active
                          ? 'bg-navy-800 font-medium text-white'
                          : 'text-navy-200 hover:bg-navy-800/60 hover:text-white',
                      )}
                    >
                      {active ? (
                        <span
                          className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-teal-400"
                          aria-hidden
                        />
                      ) : null}
                      <Icon className={cn('size-4 shrink-0', active ? 'text-teal-300' : 'text-navy-400')} />
                      <span className="truncate">{item.label}</span>
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

export function DesktopSidebar({ permissions, isSuperAdmin }: { permissions: string[]; isSuperAdmin: boolean }) {
  return (
    <aside className="hidden w-64 shrink-0 flex-col overflow-y-auto border-r border-navy-800 bg-navy-900 lg:flex">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-navy-800 px-5">
        <div className="grid size-7 place-items-center rounded-md bg-teal-500 text-xs font-bold text-navy-950">
          FID
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">FID Trading</p>
          <p className="truncate text-[10px] text-navy-400">Business Management</p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SidebarNav permissions={permissions} isSuperAdmin={isSuperAdmin} />
      </div>
    </aside>
  );
}
