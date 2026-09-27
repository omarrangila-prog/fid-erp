'use client';

import * as React from 'react';
import { GuidedChooser } from '@/app/(app)/accounting/journal/new/guided-chooser';

/**
 * General Entry's three ways in: the simple two-sided entry most people want,
 * the guided list that sends a business event to its own screen, and the
 * multi-line journal for an accountant. All three stay on the page so a
 * half-filled form is not lost by looking at another tab.
 */
export function GeneralEntryTabs({ simple, advanced }: { simple: React.ReactNode; advanced: React.ReactNode }) {
  const [tab, setTab] = React.useState<'simple' | 'guided' | 'advanced'>('simple');
  const tabs = [
    ['simple', 'Simple entry'],
    ['guided', 'Guided — open the right screen'],
    ['advanced', 'Advanced journal entry'],
  ] as const;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 rounded-lg border border-line bg-surface-sunken p-1" role="group" aria-label="How to enter it">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
            className={
              tab === id
                ? 'rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-ink shadow-sm'
                : 'rounded-md px-3 py-1.5 text-xs font-medium text-ink-muted hover:text-ink'
            }
          >
            {label}
          </button>
        ))}
      </div>
      <div hidden={tab !== 'simple'}>{simple}</div>
      <div hidden={tab !== 'guided'}>
        <GuidedChooser onAdvanced={() => setTab('advanced')} />
      </div>
      <div hidden={tab !== 'advanced'}>{advanced}</div>
    </div>
  );
}
