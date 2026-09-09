'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * Opens the print dialogue when the page is reached with `?print=1`, so a
 * "Print invoice" link elsewhere lands the user straight in the dialogue
 * rather than on a page they then have to print themselves.
 */
export function AutoPrint() {
  const params = useSearchParams();
  const shouldPrint = params.get('print') === '1';

  React.useEffect(() => {
    if (!shouldPrint) return;
    const handle = window.setTimeout(() => window.print(), 400);
    return () => window.clearTimeout(handle);
  }, [shouldPrint]);

  return null;
}
