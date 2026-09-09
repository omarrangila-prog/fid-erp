'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';

/**
 * Tabs for record detail pages. The list scrolls horizontally on narrow screens
 * rather than wrapping, which keeps the relationship between the tabs legible
 * on a phone.
 */
export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        'flex w-full gap-1 overflow-x-auto border-b border-line pb-px [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'relative shrink-0 whitespace-nowrap px-3 py-2.5 text-sm font-medium text-ink-muted transition-colors',
        'hover:text-ink',
        'data-[state=active]:text-forest-800',
        'after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-transparent',
        'data-[state=active]:after:bg-gold-600',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('animate-in-soft pt-5 outline-none', className)} {...props} />;
}

/** A count badge shown beside a tab label. */
export function TabCount({ value }: { value: number }) {
  if (value === 0) return null;
  return (
    <span className="tnum ml-1.5 rounded bg-forest-100 px-1.5 py-0.5 text-[10px] font-semibold text-forest-700">
      {value}
    </span>
  );
}
