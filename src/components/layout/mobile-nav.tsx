'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X, MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MOBILE_PRIMARY } from '@/components/layout/nav-config';
import { SidebarNav } from '@/components/layout/sidebar';

/**
 * Mobile navigation is a different design, not a squeezed sidebar: the four
 * destinations field staff actually use live in a thumb-reachable bottom bar,
 * and everything else sits behind "More".
 */
export function MobileNav({ permissions, isSuperAdmin }: { permissions: string[]; isSuperAdmin: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  const granted = new Set(permissions);
  const primary = MOBILE_PRIMARY.filter((item) => isSuperAdmin || item.permissions.some((p) => granted.has(p)));

  return (
    <>
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur lg:hidden">
        <ul className="grid" style={{ gridTemplateColumns: `repeat(${primary.length + 1}, minmax(0, 1fr))` }}>
          {primary.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex flex-col items-center gap-1 px-1 py-2.5 text-[10px] font-medium transition-colors',
                    active ? 'text-teal-700' : 'text-ink-muted',
                  )}
                >
                  <Icon className="size-5" />
                  <span className="truncate">{item.label}</span>
                </Link>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="flex w-full flex-col items-center gap-1 px-1 py-2.5 text-[10px] font-medium text-ink-muted"
            >
              <MoreHorizontal className="size-5" />
              <span>More</span>
            </button>
          </li>
        </ul>
      </nav>

      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-navy-950/40 lg:hidden" />
          <DialogPrimitive.Content className="animate-in-soft fixed inset-y-0 left-0 z-50 flex w-[17rem] flex-col bg-navy-900 shadow-2xl lg:hidden">
            <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              All application sections available to you
            </DialogPrimitive.Description>
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-navy-800 px-4">
              <div className="flex items-center gap-2.5">
                <div className="grid size-7 place-items-center rounded-md bg-teal-500 text-xs font-bold text-navy-950">
                  FID
                </div>
                <p className="text-sm font-semibold text-white">FID Trading</p>
              </div>
              <DialogPrimitive.Close
                aria-label="Close navigation"
                className="rounded-md p-1 text-navy-300 hover:bg-navy-800 hover:text-white"
              >
                <X className="size-5" />
              </DialogPrimitive.Close>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pb-6">
              <SidebarNav
                permissions={permissions}
                isSuperAdmin={isSuperAdmin}
                onNavigate={() => setOpen(false)}
              />
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
