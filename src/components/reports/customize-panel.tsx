'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { SlidersHorizontal, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { saveReportViewAction } from '@/server/actions/report-actions';

/**
 * Customize: every setting a report takes, in one panel, applied together.
 *
 * The controls on the report itself are quick to reach one at a time; this
 * panel is for setting several at once — the period, how the columns are
 * laid out, what to compare with, whether empty lines show — and then saving
 * the whole arrangement under a name so it opens the same way next time.
 * Which controls appear depends on what the report understands.
 */
export type CustomizeField = 'period' | 'asOf' | 'columns' | 'compare' | 'zero';

export function CustomizePanel({
  report,
  fields,
  children,
}: {
  /** Shown as the panel's title and used as the default saved name. */
  report: string;
  fields: CustomizeField[];
  /** Report-specific filters, rendered inside the panel; they patch the same draft. */
  children?: (draft: Record<string, string>, patch: (key: string, value: string) => void) => React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [name, setName] = React.useState(report);
  const [saving, startSaving] = React.useTransition();

  // The draft starts from whatever the address already says, each time the panel opens.
  const openPanel = () => {
    const next: Record<string, string> = {};
    searchParams.forEach((value, key) => {
      next[key] = value;
    });
    setDraft(next);
    setOpen(true);
  };

  const patch = (key: string, value: string) =>
    setDraft((current) => {
      const next = { ...current };
      if (value === '') delete next[key];
      else next[key] = value;
      return next;
    });

  const href = () => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(draft)) if (value !== '') params.set(key, value);
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  };

  const apply = () => {
    router.push(href());
    setOpen(false);
  };

  const save = () => {
    startSaving(async () => {
      const result = await saveReportViewAction({ name, href: href() });
      if (result.ok) {
        toast.success(result.message ?? 'Saved.');
        router.push(href());
        setOpen(false);
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={openPanel} className="print:hidden">
        <SlidersHorizontal className="size-4" />
        Customize
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={`Customize ${report}`}
        description="Set the period, columns and comparison together, then apply — or save the arrangement under a name."
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={apply}>
              Apply
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          {fields.includes('period') ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="From" htmlFor="customize-from">
                <Input id="customize-from" type="date" value={draft.from ?? ''} onChange={(e) => patch('from', e.target.value)} />
              </Field>
              <Field label="To" htmlFor="customize-to">
                <Input id="customize-to" type="date" value={draft.to ?? ''} onChange={(e) => patch('to', e.target.value)} />
              </Field>
            </div>
          ) : null}
          {fields.includes('asOf') ? (
            <Field label="As at" htmlFor="customize-asof">
              <Input id="customize-asof" type="date" value={draft.asOf ?? ''} onChange={(e) => patch('asOf', e.target.value)} />
            </Field>
          ) : null}
          {fields.includes('columns') ? (
            <Field label="Display columns by" htmlFor="customize-columns">
              <Select id="customize-columns" value={draft.columns ?? 'total'} onChange={(e) => patch('columns', e.target.value === 'total' ? '' : e.target.value)}>
                <option value="total">Total only</option>
                <option value="month">Month</option>
                <option value="quarter">Quarter</option>
                <option value="year">Year</option>
              </Select>
            </Field>
          ) : null}
          {fields.includes('compare') ? (
            <Field label="Compare with" htmlFor="customize-compare">
              <Select id="customize-compare" value={draft.compare ?? 'none'} onChange={(e) => patch('compare', e.target.value === 'none' ? '' : e.target.value)}>
                <option value="none">No comparison</option>
                <option value="previous">Previous period</option>
                <option value="year">Previous year</option>
              </Select>
            </Field>
          ) : null}
          {fields.includes('zero') ? (
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" className="size-4 accent-gold-600" checked={draft.zero === '1'} onChange={(e) => patch('zero', e.target.checked ? '1' : '')} />
              Show zero-balance lines
            </label>
          ) : null}
          {children ? children(draft, patch) : null}

          <div className="space-y-2 rounded-lg border border-line bg-surface-sunken/40 p-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Save this arrangement</p>
            <Field label="Name" htmlFor="customize-name" hint="It will appear under My custom reports in the report centre.">
              <Input id="customize-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={`${report} — monthly`} />
            </Field>
            <Button type="button" variant="subtle" size="sm" onClick={save} disabled={saving || name.trim().length === 0}>
              <Save className="size-4" />
              {saving ? 'Saving…' : 'Save custom report'}
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
