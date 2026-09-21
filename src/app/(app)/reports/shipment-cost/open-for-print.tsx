'use client';

import * as React from 'react';

/**
 * Print every shipment open.
 *
 * The rows are collapsed on screen so the page stays short; on paper a
 * closed row is a heading with nothing under it. Each `<details>` is opened
 * for the print and put back afterwards.
 */
export function OpenAllForPrint() {
  React.useEffect(() => {
    let touched: HTMLDetailsElement[] = [];
    const before = () => {
      touched = [...document.querySelectorAll<HTMLDetailsElement>('details[data-testid="shipment-costing-row"]:not([open])')];
      for (const d of touched) d.open = true;
    };
    const after = () => {
      for (const d of touched) d.open = false;
      touched = [];
    };
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);
  return null;
}
