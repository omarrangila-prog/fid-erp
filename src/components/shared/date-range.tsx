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

  function preset(kind: 'month' | 'quarter' | 'year' | 'ytd') {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    let start: Date;
    let end: Date;

    if (kind === 'month') {
      start = new Date(Date.UTC(year, month, 1));
      end = new Date(Date.UTC(year, month + 1, 0));
    } else if (kind === 'quarter') {
      const q = Math.floor(month / 3);
      start = new Date(Date.UTC(year, q * 3, 1));
      end = new Date(Date.UTC(year, q * 3 + 3, 0));
    } else if (kind === 'year') {
      start = new Date(Date.UTC(year, 0, 1));
      end = new Date(Date.UTC(year, 11, 31));
    } else {
      start = new Date(Date.UTC(year, 0, 1));
      end = now;
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
          {(
            [
              ['month', 'This month'],
              ['quarter', 'This quarter'],
              ['ytd', 'Year to date'],
              ['year', 'This year'],
            ] as const
          ).map(([kind, label]) => (
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
