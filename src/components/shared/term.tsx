'use client';

import { useTerms } from '@/components/company-config-context';
import type { TermKey } from '@/lib/terminology';

/** A word in the company's own vocabulary, usable from a server or a client component. */
export function Term({ k, lower = false }: { k: TermKey; lower?: boolean }) {
  const terms = useTerms();
  return <>{lower ? terms.lower(k) : terms(k)}</>;
}
