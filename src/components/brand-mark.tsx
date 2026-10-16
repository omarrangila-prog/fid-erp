'use client';

import { useBrand } from '@/components/brand-context';
import { cn } from '@/lib/utils';

/** The product's logo tile: its short mark on the brand colour. */
export function BrandMark({ className }: { className?: string }) {
  const { shortName } = useBrand();
  return (
    <div
      aria-hidden
      className={cn('grid shrink-0 place-items-center rounded-lg font-bold tracking-tight', className)}
    >
      {shortName}
    </div>
  );
}

/** The product name as plain text. */
export function BrandName({ className }: { className?: string }) {
  return <span className={className}>{useBrand().name}</span>;
}

/** The product tagline as plain text. */
export function BrandTagline({ className }: { className?: string }) {
  return <span className={className}>{useBrand().tagline}</span>;
}
