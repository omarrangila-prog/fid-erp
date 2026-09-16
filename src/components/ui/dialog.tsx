'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/**
 * Stacking for every modal in the app:
 *
 *   overlay   z-80  — dims the page only
 *   content   z-90  — the form, always above the overlay
 *   popovers  z-110 — comboboxes/menus opened from inside a modal
 *
 * Overlay and content used to share z-80 while the Sheet sat at z-50, so the
 * dimmer landed on top of Add Customer, blurred the fields and ate every
 * click. Backdrop-filter on that covering overlay is what made the *form*
 * itself look fogged: it blurs whatever is behind it, which was the dialog.
 */
function Overlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-fid-overlay
      className={cn('fixed inset-0 z-[80] bg-forest-950/45', className)}
      {...props}
    />
  );
}

/**
 * Centred modal on desktop; on small screens it sits at the bottom of the
 * viewport where a thumb can reach it.
 */
export function DialogContent({
  className,
  children,
  title,
  description,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { title: string; description?: string }) {
  return (
    <DialogPrimitive.Portal>
      <Overlay />
      <DialogPrimitive.Content
        data-fid-dialog
        className={cn(
          'pointer-events-auto fixed z-[90] flex max-h-[92vh] flex-col overflow-hidden bg-surface shadow-xl',
          'inset-x-0 bottom-0 rounded-t-2xl',
          'sm:inset-x-auto sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:w-[min(38rem,92vw)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl',
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="space-y-0.5">
            <DialogPrimitive.Title className="text-sm font-semibold text-ink">{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="text-xs text-ink-muted">
                {description}
              </DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close
            aria-label="Close"
            className="rounded-md p-1 text-ink-subtle transition-colors hover:bg-forest-50 hover:text-ink"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('mt-5 flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

/** Right-hand drawer used for record detail without losing the list behind it. */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 'md',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: 'md' | 'lg' | 'xl';
}) {
  const widths = { md: 'sm:w-[32rem]', lg: 'sm:w-[42rem]', xl: 'sm:w-[54rem]' } as const;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <Overlay />
        <DialogPrimitive.Content
          data-fid-dialog
          className={cn(
            'pointer-events-auto animate-in-soft fixed z-[90] flex flex-col bg-surface shadow-2xl',
            'inset-x-0 bottom-0 max-h-[92vh] rounded-t-2xl',
            'sm:inset-y-0 sm:right-0 sm:left-auto sm:max-h-none sm:w-full sm:rounded-none sm:border-l sm:border-line',
            widths[width],
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="space-y-0.5">
              <DialogPrimitive.Title className="text-sm font-semibold text-ink">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="text-xs text-ink-muted">
                  {description}
                </DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              className="rounded-md p-1 text-ink-subtle transition-colors hover:bg-forest-50 hover:text-ink"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="border-t border-line px-5 py-3">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
