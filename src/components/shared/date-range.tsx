'use client';

import * as React from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';

/**
 * Period picker for the reports. The selection lives in the URL so a report can
 * be bookmarked, shared or refreshed and still show the same period.
 */
const PRESETS = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['last2', 'Last 2 days'],
  ['last7', 'Last 7 days'],
  ['week', 'This week'],
  ['month', 'This month'],
  ['lastMonth', 'Last month'],
  ['quarter', 'This quarter'],
  ['ytd', 'Year to date'],
  ['year', 'This year'],
  ['all', 'Everything'],
] as const;

type PresetKind = (typeof PRESETS)[number][0];

export function DateRangePicker({
  defaultFrom,
  defaultTo,
  presets = true,
}: {
  defaultFrom: string;
  defaultTo: string;
  presets?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [from, setFrom] = React.useState(searchParams.get('from') ?? defaultFrom);
  const [to, setTo] = React.useState(searchParams.get('to') ?? defaultTo);

  function apply(nextFrom: string, nextTo: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('from', nextFrom);
    params.set('to', nextTo);
    router.push(`${pathname}?${params.toString()}`);
  }

  /**
   * The periods a trader actually asks for.
   *
   * "How did today go", "what about the last two days", "this month so far"
   * — each one is a click rather than two date fields and a mental note of
   * what day of the month it is. "Everything" answers the question the client
   * asks most: how are we doing since we started.
   */
  function preset(kind: PresetKind) {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const today = new Date(Date.UTC(year, month, now.getUTCDate()));
    const daysAgo = (n: number) => new Date(today.getTime() - n * 86_400_000);

    let start: Date;
    let end: Date = today;

    switch (kind) {
      case 'today':
        start = today;
        break;
      case 'yesterday':
        start = daysAgo(1);
        end = daysAgo(1);
        break;
      case 'last2':
        start = daysAgo(1);
        break;
      case 'last7':
        start = daysAgo(6);
        break;
      case 'week': {
        // Monday, the way a working week is counted here.
        const weekday = (today.getUTCDay() + 6) % 7;
        start = daysAgo(weekday);
        break;
      }
      case 'month':
        start = new Date(Date.UTC(year, month, 1));
        end = new Date(Date.UTC(year, month + 1, 0));
        break;
      case 'lastMonth':
        start = new Date(Date.UTC(year, month - 1, 1));
        end = new Date(Date.UTC(year, month, 0));
        break;
      case 'quarter': {
        const q = Math.floor(month / 3);
        start = new Date(Date.UTC(year, q * 3, 1));
        end = new Date(Date.UTC(year, q * 3 + 3, 0));
        break;
      }
      case 'year':
        start = new Date(Date.UTC(year, 0, 1));
        end = new Date(Date.UTC(year, 11, 31));
        break;
      case 'ytd':
        start = new Date(Date.UTC(year, 0, 1));
        break;
      case 'all':
      default:
        // Far enough back to precede any book this application will hold.
        start = new Date(Date.UTC(2000, 0, 1));
        break;
    }

    const nextFrom = start.toISOString().slice(0, 10);
    const nextTo = end.toISOString().slice(0, 10);
    setFrom(nextFrom);
    setTo(nextTo);
    apply(nextFrom, nextTo);
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="From" htmlFor="from" className="w-40">
        <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </Field>
      <Field label="To" htmlFor="to" className="w-40">
        <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </Field>
      <Button variant="outline" onClick={() => apply(from, to)}>
        Apply
      </Button>
      {presets ? (
        <div className="flex flex-wrap gap-1">
          {PRESETS.map(([kind, label]) => (
            <Button key={kind} variant="ghost" size="sm" onClick={() => preset(kind)}>
              {label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Single "as at" date picker for point-in-time reports. */
export function AsOfPicker({ defaultDate }: { defaultDate: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [asOf, setAsOf] = React.useState(searchParams.get('asOf') ?? defaultDate);

  return (
    <div className="flex items-end gap-2">
      <Field label="As at" htmlFor="asOf" className="w-40">
        <Input id="asOf" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
      </Field>
      <Button
        variant="outline"
        onClick={() => {
          const params = new URLSearchParams(searchParams.toString());
          params.set('asOf', asOf);
          router.push(`${pathname}?${params.toString()}`);
        }}
      >
        Apply
      </Button>
    </div>
  );
}
