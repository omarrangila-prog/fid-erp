'use client';

import { createContext, useCallback, useContext } from 'react';
import type { Feature } from '@/lib/features';

type Resolved = Record<Feature, boolean>;
const FeaturesContext = createContext<Resolved | null>(null);

/** Hands the active company's resolved feature switches to client components. */
export function FeaturesProvider({ features, children }: { features: Resolved; children: React.ReactNode }) {
  return <FeaturesContext.Provider value={features}>{children}</FeaturesContext.Provider>;
}

/** `has('AGENTS')` — true when the active company has that module on. */
export function useFeatures(): (feature: Feature) => boolean {
  const features = useContext(FeaturesContext);
  // Stable between renders, so it is safe in a dependency list.
  return useCallback((feature: Feature) => (features ? features[feature] !== false : true), [features]);
}
