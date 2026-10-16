'use client';

import { useBrand } from '@/components/brand-context';
import { cn } from '@/lib/utils';

/** The product's logo tile: its short mark on the brand colour. */
export function BrandMark({ className }: { className?: string }) {
  const { icon } = useBrand();
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={icon} alt="" aria-hidden className={cn('shrink-0 rounded-lg', className)} />;
}

/** The product name as plain text. */
export function BrandName({ className }: { className?: string }) {
  return <span className={className}>{useBrand().name}</span>;
}

/** The product tagline as plain text. */
export function BrandTagline({ className }: { className?: string }) {
  return <span className={className}>{useBrand().tagline}</span>;
}
