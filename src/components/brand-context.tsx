'use client';

import { createContext, useContext } from 'react';
import type { Brand } from '@/lib/brand';

const BrandContext = createContext<Brand | null>(null);

/** Hands the server-read product brand to client components. */
export function BrandProvider({ brand, children }: { brand: Brand; children: React.ReactNode }) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export function useBrand(): Brand {
  const brand = useContext(BrandContext);
  if (!brand) throw new Error('useBrand must be used under <BrandProvider> (root layout).');
  return brand;
}
