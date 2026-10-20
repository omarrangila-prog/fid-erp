'use client';

import * as React from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { FilterApply, FilterBar, FilterCell, FilterChips, FilterDate, FilterSelect } from '@/components/shared/filter-bar';

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
  ['lastWeek', 'Last week'],
  ['month', 'This month'],
  ['lastMonth', 'Last month'],
  ['quarter', 'This quarter'],
  ['lastQuarter', 'Last quarter'],
  ['ytd', 'Year to date'],
  ['year', 'This year'],
  ['lastYear', 'Last year'],
  ['all', 'All dates'],
] as const;

type PresetKind = (typeof PRESETS)[number][0];

/** The ones asked for most, one click away under the bar. */
const QUICK: PresetKind[] = ['month', 'lastMonth', 'quarter', 'ytd', 'lastYear', 'all'];

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

  const appliedFrom = searchParams.get('from') ?? defaultFrom;
  const appliedTo = searchParams.get('to') ?? defaultTo;
  const dirty = from !== appliedFrom || to !== appliedTo;
  const active = PRESETS.find(([kind]) => {
    const r = presetRange(kind);
    return r.from === appliedFrom && r.to === appliedTo;
  })?.[0];

  function apply(nextFrom: string, nextTo: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('from', nextFrom);
    params.set('to', nextTo);
    router.push(`${pathname}?${params.toString()}`);
  }

  function preset(kind: PresetKind) {
    const r = presetRange(kind);
    setFrom(r.from);
    setTo(r.to);
    apply(r.from, r.to);
  }

  return (
    <div className="space-y-2 print:hidden" data-date-range="">
      <FilterBar className="md:inline-flex">
        <FilterCell label="From" htmlFor="from" className="md:w-48">
          <FilterDate id="from" value={from} onChange={setFrom} empty="Beginning" />
        </FilterCell>
        <FilterCell label="To" htmlFor="to" className="md:w-48">
          <FilterDate id="to" value={to} onChange={setTo} empty="Today" />
        </FilterCell>
        {presets ? (
          <FilterCell label="Report period" htmlFor="reportPeriod" className="md:w-48">
            <FilterSelect
              id="reportPeriod"
              value={active ?? ''}
              onChange={(e) => {
                if (e.target.value) preset(e.target.value as PresetKind);
              }}
            >
              <option value="">Custom dates</option>
              {PRESETS.map(([kind, label]) => (
                <option key={kind} value={kind}>
                  {label}
                </option>
              ))}
            </FilterSelect>
          </FilterCell>
        ) : null}
        <FilterApply dirty={dirty} onClick={() => apply(from, to)} />
      </FilterBar>
      {presets ? (
        <FilterChips
          label="Quick"
          options={QUICK.map((kind) => ({ value: kind, label: PRESETS.find(([k]) => k === kind)![1] }))}
          value={active ?? null}
          onSelect={(kind) => preset(kind as PresetKind)}
        />
      ) : null}
    </div>
  );
}

/**
 * The periods a trader actually asks for.
 *
 * "How did today go", "what about the last two days", "this month so far"
 * — each one is a click rather than two date fields and a mental note of
 * what day of the month it is. "Everything" answers the question the client
 * asks most: how are we doing since we started.
 */
function presetRange(kind: PresetKind): { from: string; to: string } {
  // The user's own calendar day, held as midnight UTC like every date in
  // the books. Reading the UTC clock put "Today" on yesterday until 4am in
  // Dubai.
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const today = new Date(Date.UTC(year, month, now.getDate()));
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
    case 'lastWeek': {
      const weekday = (today.getUTCDay() + 6) % 7;
      start = daysAgo(weekday + 7);
      end = daysAgo(weekday + 1);
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
    case 'lastQuarter': {
      const q = Math.floor(month / 3) - 1;
      start = new Date(Date.UTC(year, q * 3, 1));
      end = new Date(Date.UTC(year, q * 3 + 3, 0));
      break;
    }
    case 'year':
      start = new Date(Date.UTC(year, 0, 1));
      end = new Date(Date.UTC(year, 11, 31));
      break;
    case 'lastYear':
      start = new Date(Date.UTC(year - 1, 0, 1));
      end = new Date(Date.UTC(year - 1, 11, 31));
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

  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

/** Single "as at" date picker for point-in-time reports. */
export function AsOfPicker({ defaultDate }: { defaultDate: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const applied = searchParams.get('asOf') ?? defaultDate;
  const [asOf, setAsOf] = React.useState(applied);

  return (
    <FilterBar className="md:inline-flex">
      <FilterCell label="As at" htmlFor="asOf" className="md:w-52">
        <FilterDate id="asOf" value={asOf} onChange={setAsOf} empty="Today" />
      </FilterCell>
      <FilterApply
        dirty={asOf !== applied}
        onClick={() => {
          const params = new URLSearchParams(searchParams.toString());
          params.set('asOf', asOf);
          router.push(`${pathname}?${params.toString()}`);
        }}
      />
    </FilterBar>
  );
}
