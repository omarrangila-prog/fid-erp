'use client';

import * as React from 'react';

/** Who is sharing and for which company — the heading every shared report carries. */
export type ShareEnv = { company: string; userName: string; canNeverExpire: boolean; letterhead?: string[]; product?: string };

const ShareContext = React.createContext<ShareEnv>({ company: '', userName: '', canNeverExpire: false });

export function ShareProvider({ value, children }: { value: ShareEnv; children: React.ReactNode }) {
  return <ShareContext.Provider value={value}>{children}</ShareContext.Provider>;
}

export function useShareEnv(): ShareEnv {
  return React.useContext(ShareContext);
}
