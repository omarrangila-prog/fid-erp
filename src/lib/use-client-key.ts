'use client';

import * as React from 'react';

/**
 * One submission key per opened form.
 *
 * Sent with Save or Post. The server records the first document created with
 * a key and hands that same document back for any repeat — a double click, a
 * retry after a slow network — so one form can never create two receipts,
 * payments, expenses or loans. Issued on first use, inside an event handler,
 * so rendering stays pure.
 */
export function useClientKey(): () => string {
  const key = React.useRef<string | null>(null);
  return React.useCallback(() => {
    if (!key.current) {
      key.current =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    }
    return key.current;
  }, []);
}
