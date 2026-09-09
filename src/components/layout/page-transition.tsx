'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';

/**
 * A short fade as the content changes.
 *
 * Keyed on the path, because the layout persists across navigations — without
 * a key the animation would run once, on first load, and never again.
 *
 * The point is not decoration. Server-rendered navigation can swap a whole
 * screen between two frames, and a page that changes with no transition at all
 * reads as a flicker; 180ms is enough to register as "this is now a different
 * page" and short enough that nobody waiting on it ever notices waiting. Under
 * prefers-reduced-motion it is disabled globally, in the stylesheet.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="animate-page mx-auto w-full max-w-[100rem]">
      {children}
    </div>
  );
}
