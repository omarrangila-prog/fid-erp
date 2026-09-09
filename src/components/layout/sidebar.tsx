'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as Popover from '@radix-ui/react-popover';
import { ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NAV_GROUPS, filterNav, type NavGroup } from '@/components/layout/nav-config';

/**
 * The navigation is filtered on the client from permission codes rather than
 * being passed pre-rendered, so the icon components never have to cross the
 * server/client boundary. It is a convenience filter only — every route also
 * checks the same permission server-side.
 *
 * Groups behave as dropdowns: forty screens in one unbroken list is a lot to
 * scan when you only ever use six of them. Which groups you leave open is
 * remembered, because re-opening the same two sections after every reload is
 * the kind of small tax that makes software feel hostile.
 *
 * Collapsing the rail switches to one icon per *group*, not per screen. The
 * earlier version kept every item icon, which made the collapsed rail taller
 * than the expanded one and hid the labels inside a scrolling container that
 * clipped them — collapsing cost you the width and gave you nothing. Now the
 * rail is eight icons, and a group's screens open in a flyout that is
 * portalled out of the scroll container so nothing can clip it.
 */

const SIDEBAR_COOKIE = 'fid_sidebar';
const OPEN_GROUPS_KEY = 'fid.nav.openGroups';

function rememberWidth(collapsed: boolean) {
  // A cookie rather than localStorage so the server renders the right width on
  // the first paint — no flash of the wrong layout on every navigation.
  document.cookie = `${SIDEBAR_COOKIE}=${collapsed ? 'collapsed' : 'expanded'};path=/;max-age=31536000;samesite=lax`;
}

/**
 * Which groups are open, read straight from localStorage.
 *
 * `useSyncExternalStore` rather than an effect that copies storage into state:
 * the server has no localStorage, so the first client render has to agree with
 * the server's, and setting state in an effect to correct it afterwards costs a
 * second render on every navigation. This reads the real value at render time
 * on the client and the server-safe empty set on the server.
 */
const NO_GROUPS: readonly string[] = [];
const listeners = new Set<() => void>();

let cachedRaw: string | null = null;
let cachedValue: readonly string[] = NO_GROUPS;

function readOpenGroups(): readonly string[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(OPEN_GROUPS_KEY);
  } catch {
    // A blocked or full localStorage must not take the navigation down with it.
    return NO_GROUPS;
  }
  // The snapshot has to be referentially stable or React re-renders forever.
  if (raw === cachedRaw) return cachedValue;
  cachedRaw = raw;
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    cachedValue = Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : NO_GROUPS;
  } catch {
    cachedValue = NO_GROUPS;
  }
  return cachedValue;
}

function subscribeOpenGroups(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

function writeOpenGroups(next: readonly string[]) {
  try {
    window.localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify(next));
  } catch {
    // Remembering is a convenience; failing to remember is not an error.
  }
  for (const listener of listeners) listener();
}

/** Longest-prefix match, so /inventory does not light up on /inventory/batches. */
function useActiveHref(groups: NavGroup[]) {
  const pathname = usePathname();
  return React.useMemo(() => {
    const candidates = groups.flatMap((group) => group.items.map((item) => item.href));
    return candidates
      .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
      .sort((a, b) => b.length - a.length)[0];
  }, [groups, pathname]);
}

function NavLink({
  href,
  label,
  icon: Icon,
  active,
  onNavigate,
}: {
  href: string;
  label: string;
  icon: NavGroup['items'][number]['icon'];
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex items-center gap-2.5 rounded-lg py-2 pl-5 pr-3 text-sm transition-colors',
        active ? 'bg-forest-800 font-medium text-white' : 'text-forest-200 hover:bg-forest-800/60 hover:text-white',
      )}
    >
      {active ? <span className="absolute inset-y-1 left-0 w-[3px] rounded-r bg-gold-400" aria-hidden /> : null}
      <Icon className={cn('size-4 shrink-0', active ? 'text-gold-300' : 'text-forest-300')} />
      <span className="truncate">{label}</span>
    </Link>
  );
}

/** The full-width navigation: accordion groups, one open section at a time or several. */
function ExpandedNav({
  groups,
  activeHref,
  onNavigate,
}: {
  groups: NavGroup[];
  activeHref: string | undefined;
  onNavigate?: () => void;
}) {
  const openGroups = React.useSyncExternalStore(subscribeOpenGroups, readOpenGroups, () => NO_GROUPS);

  function toggleGroup(label: string) {
    writeOpenGroups(
      openGroups.includes(label) ? openGroups.filter((entry) => entry !== label) : [...openGroups, label],
    );
  }

  return (
    <nav className="flex flex-col gap-1 px-3 py-4" aria-label="Main">
      {groups.map((group) => {
        const holdsActive = group.items.some((item) => item.href === activeHref);
        // The section you are working in is always open, so the rail shows
        // where you are without you having to hunt for it.
        const isOpen = holdsActive || openGroups.includes(group.label);
        const bodyId = `nav-group-${group.label.replace(/\s+/g, '-').toLowerCase()}`;

        return (
          <div key={group.label} className="pb-2">
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
              <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', isOpen && 'rotate-90')} aria-hidden />
              <span className="flex-1 truncate text-left">{group.label}</span>
              {!isOpen ? (
                <span className="tnum rounded-full bg-forest-800 px-1.5 text-[11px] font-medium text-forest-300">
                  {group.items.length}
                </span>
              ) : null}
            </button>

            <ul id={bodyId} className={cn('space-y-0.5', !isOpen && 'hidden')}>
              {group.items.map((item) => (
                <li key={item.href}>
                  <NavLink
                    href={item.href}
                    label={item.label}
                    icon={item.icon}
                    active={item.href === activeHref}
                    onNavigate={onNavigate}
                  />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/**
 * The collapsed rail: one button per group, each opening a flyout of that
 * group's screens.
 *
 * Radix portals the flyout to the document body, which is the point — the rail
 * scrolls, and anything positioned inside a scrolling container gets clipped at
 * its edge.
 */
function CollapsedRail({ groups, activeHref }: { groups: NavGroup[]; activeHref: string | undefined }) {
  const [openGroup, setOpenGroup] = React.useState<string | null>(null);

  return (
    <nav className="flex flex-col gap-1 px-2 py-4" aria-label="Main">
      {groups.map((group) => {
        const holdsActive = group.items.some((item) => item.href === activeHref);
        const GroupIcon = group.icon;

        return (
          <Popover.Root
            key={group.label}
            open={openGroup === group.label}
            onOpenChange={(open) => setOpenGroup(open ? group.label : null)}
          >
            <Popover.Trigger asChild>
              <button
                type="button"
                aria-label={`${group.label} — ${group.items.length} screens`}
                className={cn(
                  'flex w-full items-center justify-center rounded-lg p-2.5 transition-colors',
                  holdsActive
                    ? 'bg-forest-800 text-gold-300'
                    : 'text-forest-300 hover:bg-forest-800/60 hover:text-white',
                )}
              >
                <GroupIcon className="size-5" />
              </button>
            </Popover.Trigger>

            <Popover.Portal>
              <Popover.Content
                side="right"
                align="start"
                sideOffset={8}
                className="z-50 w-60 rounded-lg border border-forest-800 bg-forest-900 p-1.5 shadow-overlay"
              >
                <p className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-forest-300">
                  {group.label}
                </p>
                <ul className="space-y-0.5">
                  {group.items.map((item) => (
                    <li key={item.href}>
                      <NavLink
                        href={item.href}
                        label={item.label}
                        icon={item.icon}
                        active={item.href === activeHref}
                        onNavigate={() => setOpenGroup(null)}
                      />
                    </li>
                  ))}
                </ul>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        );
      })}
    </nav>
  );
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
  const groups = React.useMemo(
    () => filterNav(NAV_GROUPS, permissions, isSuperAdmin),
    [permissions, isSuperAdmin],
  );
  const activeHref = useActiveHref(groups);

  return collapsed ? (
    <CollapsedRail groups={groups} activeHref={activeHref} />
  ) : (
    <ExpandedNav groups={groups} activeHref={activeHref} onNavigate={onNavigate} />
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

      {/* overflow-x-visible would be ignored next to overflow-y-auto, which is
          exactly why the collapsed flyouts are portalled rather than nested. */}
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
