'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Search, Bell, ChevronDown, Check, LogOut, KeyRound, Building2, Loader2,
  Plus, CornerDownLeft, Compass, HelpCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { initials } from '@/lib/format';
import { searchAction, switchCompanyAction, logoutAction } from '@/server/actions/session-actions';
import { filterQuickCreate, navDestinations } from '@/components/layout/nav-config';
import type { SearchResult } from '@/lib/services/search';

export type TopbarCompany = { id: string; code: string; name: string; localCurrency: string };

export type TopbarUser = {
  id: string;
  name: string;
  email: string;
  roleNames: string[];
  isSuperAdmin: boolean;
};

/**
 * Command palette.
 *
 * ⌘K is the fastest route to anywhere in the application: it jumps to screens
 * *and* finds records. Screen matching happens on the client from the same
 * permission-filtered navigation the sidebar uses; record matching goes to the
 * server, which scopes results to the active company and the user's rights.
 */
function CommandPalette({
  open,
  onOpenChange,
  permissions,
  isSuperAdmin,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  permissions: string[];
  isSuperAdmin: boolean;
}) {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [pending, startTransition] = React.useTransition();

  const destinations = React.useMemo(
    () => navDestinations(permissions, isSuperAdmin),
    [permissions, isSuperAdmin],
  );

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setQuery('');
      setResults([]);
    }
  }

  const trimmed = query.trim();

  React.useEffect(() => {
    if (!open) return;
    const handle = window.setTimeout(() => {
      if (trimmed.length < 2) {
        setResults([]);
        return;
      }
      startTransition(async () => {
        setResults(await searchAction(trimmed));
      });
    }, 200);
    return () => window.clearTimeout(handle);
  }, [trimmed, open]);

  const pageMatches = React.useMemo(() => {
    if (trimmed.length === 0) return destinations.slice(0, 7);
    const q = trimmed.toLowerCase();
    return destinations.filter((d) => d.label.toLowerCase().includes(q) || d.group.toLowerCase().includes(q)).slice(0, 6);
  }, [destinations, trimmed]);

  const groupedRecords = React.useMemo(() => {
    const map = new Map<string, SearchResult[]>();
    for (const result of results) {
      const list = map.get(result.type) ?? [];
      list.push(result);
      map.set(result.type, list);
    }
    return [...map.entries()];
  }, [results]);

  const nothingAtAll = trimmed.length >= 2 && pageMatches.length === 0 && groupedRecords.length === 0 && !pending;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-forest-950/30 backdrop-blur-[2px]" />
        <DialogPrimitive.Content className="animate-in-soft fixed left-1/2 top-[12vh] z-50 w-[min(36rem,calc(100vw-1.5rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-surface shadow-2xl">
          <DialogPrimitive.Title className="sr-only">Search and jump to</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Find a screen or a record. Results are limited to your company and your permissions.
          </DialogPrimitive.Description>

          <div className="flex items-center gap-2 border-b border-line px-3">
            {pending ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-ink-subtle" />
            ) : (
              <Search className="size-4 shrink-0 text-ink-subtle" />
            )}
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Go to a screen, or search a contract, invoice, customer…"
              className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-ink-subtle"
            />
            <kbd className="hidden shrink-0 rounded border border-line-strong px-1.5 py-0.5 text-[11px] font-medium text-ink-subtle sm:block">
              esc
            </kbd>
          </div>

          <div className="max-h-[26rem] overflow-y-auto p-1">
            {pageMatches.length > 0 ? (
              <div className="pb-1">
                <p className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
                  {trimmed.length === 0 ? 'Jump to' : 'Screens'}
                </p>
                {pageMatches.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => handleOpenChange(false)}
                      className="flex items-center gap-3 rounded-md px-3 py-2 transition-colors hover:bg-forest-50"
                    >
                      <Icon className="size-4 shrink-0 text-forest-400" />
                      <span className="min-w-0 flex-1 truncate text-sm text-ink">{item.label}</span>
                      <span className="shrink-0 text-[11px] text-ink-subtle">{item.group}</span>
                    </Link>
                  );
                })}
              </div>
            ) : null}

            {trimmed.length >= 2 &&
              groupedRecords.map(([type, items]) => (
                <div key={type} className="pb-1">
                  <p className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
                    {type}
                  </p>
                  {items.map((result) => (
                    <Link
                      key={`${result.type}-${result.id}`}
                      href={result.href}
                      onClick={() => handleOpenChange(false)}
                      className="block rounded-md px-3 py-2 transition-colors hover:bg-forest-50"
                    >
                      <p className="truncate text-sm font-medium text-ink">{result.title}</p>
                      <p className="truncate text-xs text-ink-muted">{result.subtitle}</p>
                    </Link>
                  ))}
                </div>
              ))}

            {trimmed.length === 1 ? (
              <p className="px-3 py-6 text-center text-xs text-ink-subtle">
                One more character and we will search your records too.
              </p>
            ) : null}

            {nothingAtAll ? (
              <p className="px-3 py-8 text-center text-xs text-ink-subtle">
                Nothing matches “{trimmed}” in this company.
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line bg-paper px-3 py-2 text-[11px] text-ink-subtle">
            <span className="inline-flex items-center gap-1.5">
              <CornerDownLeft className="size-3" />
              to open
            </span>
            <span>Only your company, only what you are permitted to see</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The global create menu — the same short list from every screen. */
function QuickCreate({ permissions, isSuperAdmin }: { permissions: string[]; isSuperAdmin: boolean }) {
  const items = React.useMemo(
    () => filterQuickCreate(permissions, isSuperAdmin),
    [permissions, isSuperAdmin],
  );
  if (items.length === 0) return null;

  const groups = ['Trade', 'Money', 'Records'] as const;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-gold-700 px-2.5 text-sm font-medium text-white transition-colors hover:bg-gold-800 sm:px-3">
        <Plus className="size-4" />
        <span className="hidden sm:inline">New</span>
        <ChevronDown className="hidden size-3.5 opacity-80 sm:block" />
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="animate-in-soft z-50 w-72 rounded-lg border border-line bg-surface p-1 shadow-xl"
        >
          {groups.map((group) => {
            const groupItems = items.filter((item) => item.group === group);
            if (groupItems.length === 0) return null;
            return (
              <div key={group} className="pb-1 last:pb-0">
                <p className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
                  {group}
                </p>
                {groupItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <DropdownMenu.Item key={item.href} asChild>
                      <Link
                        href={item.href}
                        className="flex cursor-pointer items-start gap-3 rounded-md px-3 py-2 outline-none transition-colors hover:bg-forest-50 data-[highlighted]:bg-forest-50"
                      >
                        <Icon className="mt-0.5 size-4 shrink-0 text-forest-400" />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-ink">{item.label}</span>
                          <span className="block truncate text-xs text-ink-subtle">{item.hint}</span>
                        </span>
                      </Link>
                    </DropdownMenu.Item>
                  );
                })}
              </div>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Company switcher. The active company is always visible — posting a contract
 * into the wrong company would be an expensive mistake, so the current context
 * is never ambiguous.
 */
function CompanySwitcher({ companies, active }: { companies: TopbarCompany[]; active: TopbarCompany }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  function switchTo(companyId: string) {
    if (companyId === active.id) return;
    startTransition(async () => {
      const result = await switchCompanyAction(companyId);
      if (result.ok) router.refresh();
    });
  }

  if (companies.length === 1) {
    return (
      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-forest-50 px-2.5 py-1.5">
        <Building2 className="size-4 shrink-0 text-forest-500" />
        <span className="truncate text-xs font-semibold text-forest-800">{active.name}</span>
        <span className="hidden rounded bg-forest-200 px-1.5 py-0.5 text-[11px] font-medium text-forest-700 sm:inline">
          {active.localCurrency}
        </span>
      </div>
    );
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        disabled={pending}
        className="flex min-w-0 items-center gap-2 rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 transition-colors hover:border-forest-300 disabled:opacity-60"
      >
        {pending ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-forest-500" />
        ) : (
          <Building2 className="size-4 shrink-0 text-forest-500" />
        )}
        <span className="max-w-28 truncate text-xs font-semibold text-forest-800 sm:max-w-none">{active.name}</span>
        <span className="hidden rounded bg-forest-100 px-1.5 py-0.5 text-[11px] font-medium text-forest-700 sm:inline">
          {active.localCurrency}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-ink-subtle" />
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="animate-in-soft z-50 w-64 rounded-lg border border-line bg-surface p-1 shadow-lg"
        >
          <p className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
            Switch company
          </p>
          {companies.map((company) => (
            <DropdownMenu.Item
              key={company.id}
              onSelect={() => switchTo(company.id)}
              className={cn(
                'flex cursor-pointer items-center justify-between gap-2 rounded-md px-3 py-2 text-sm outline-none transition-colors hover:bg-forest-50 data-[highlighted]:bg-forest-50',
                company.id === active.id && 'bg-gold-50',
              )}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium text-ink">{company.name}</span>
                <span className="block truncate text-xs text-ink-subtle">
                  {company.code} · {company.localCurrency}
                </span>
              </span>
              {company.id === active.id ? <Check className="size-4 shrink-0 text-gold-600" /> : null}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function UserMenu({ user }: { user: TopbarUser }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="flex shrink-0 items-center gap-2 rounded-lg p-1 transition-colors hover:bg-forest-50">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-forest-800 text-xs font-semibold text-white">
          {initials(user.name)}
        </span>
        <ChevronDown className="hidden size-3.5 text-ink-subtle sm:block" />
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="animate-in-soft z-50 w-64 rounded-lg border border-line bg-surface p-1 shadow-lg"
        >
          <div className="border-b border-line px-3 py-2.5">
            <p className="truncate text-sm font-semibold text-ink">{user.name}</p>
            <p className="truncate text-xs text-ink-muted">{user.email}</p>
            <p className="mt-1 truncate text-[11px] text-ink-subtle">
              {user.isSuperAdmin ? 'Super Admin' : user.roleNames.join(', ') || 'No role assigned'}
            </p>
          </div>

          <DropdownMenu.Item asChild>
            <Link
              href="/getting-started"
              className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm outline-none transition-colors hover:bg-forest-50 data-[highlighted]:bg-forest-50"
            >
              <Compass className="size-4 text-ink-muted" />
              Getting started
            </Link>
          </DropdownMenu.Item>

          <DropdownMenu.Item asChild>
            <Link
              href="/account"
              className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm outline-none transition-colors hover:bg-forest-50 data-[highlighted]:bg-forest-50"
            >
              <KeyRound className="size-4 text-ink-muted" />
              Change password
            </Link>
          </DropdownMenu.Item>

          <DropdownMenu.Separator className="my-1 h-px bg-line" />

          <DropdownMenu.Item asChild>
            <form action={logoutAction}>
              <button
                type="submit"
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-red-600 outline-none transition-colors hover:bg-red-50 data-[highlighted]:bg-red-50"
              >
                <LogOut className="size-4" />
                Sign out
              </button>
            </form>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function Topbar({
  user,
  companies,
  activeCompany,
  unreadCount,
  permissions,
}: {
  user: TopbarUser;
  companies: TopbarCompany[];
  activeCompany: TopbarCompany;
  unreadCount: number;
  permissions: string[];
}) {
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface/95 px-3 backdrop-blur sm:gap-3 sm:px-5">
      <div className="flex items-center gap-2 lg:hidden">
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-forest-800 text-[11px] font-bold text-white">
          FID
        </div>
      </div>

      <CompanySwitcher companies={companies} active={activeCompany} />

      {/* Wide screens get the full search field; phones get an icon. */}
      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        className="hidden h-9 flex-1 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink-subtle transition-colors hover:border-forest-300 sm:flex sm:max-w-md"
      >
        <Search className="size-4 shrink-0" />
        <span className="truncate">Search or jump to…</span>
        <kbd className="ml-auto hidden shrink-0 rounded border border-line-strong px-1.5 py-0.5 text-[11px] font-medium text-ink-subtle sm:block">
          ⌘K
        </kbd>
      </button>
      <div className="flex-1 sm:hidden" />

      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        aria-label="Search"
        className="shrink-0 rounded-lg p-2 text-ink-muted transition-colors hover:bg-forest-50 hover:text-ink sm:hidden"
      >
        <Search className="size-5" />
      </button>

      <QuickCreate permissions={permissions} isSuperAdmin={user.isSuperAdmin} />

      <Link
        href="/getting-started"
        aria-label="Getting started"
        title="Getting started"
        className="hidden shrink-0 rounded-lg p-2 text-ink-muted transition-colors hover:bg-forest-50 hover:text-ink sm:block"
      >
        <HelpCircle className="size-5" />
      </Link>

      <Link
        href="/notifications"
        aria-label={`Alerts${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
        className="relative shrink-0 rounded-lg p-2 text-ink-muted transition-colors hover:bg-forest-50 hover:text-ink"
      >
        <Bell className="size-5" />
        {unreadCount > 0 ? (
          <span className="tnum absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[11px] font-semibold text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </Link>

      <UserMenu user={user} />

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        permissions={permissions}
        isSuperAdmin={user.isSuperAdmin}
      />
    </header>
  );
}
