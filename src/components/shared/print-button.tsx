'use client';

import * as React from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Print, or save as PDF — with the page set up to fit.
 *
 * The browser's own print dialogue offers "Save as PDF" on every desktop
 * platform, which produces a better document than a server-side renderer
 * would and cannot drift from what is on screen. What the browser does not
 * do is choose the paper: a six-column cash book fits portrait, a fifteen-
 * column loading sheet does not, and a table wider than the sheet is simply
 * cut off at the edge with no warning.
 *
 * So the button carries two settings. Orientation: Auto picks landscape when
 * any table on the page has more than seven columns, and portrait otherwise;
 * Portrait and Landscape force it. Scale: Fit to width makes every table
 * take the sheet's width and wrap inside it, so no column is lost; Actual
 * size prints the table as it is on screen. Both are remembered.
 *
 * The choice is written onto <html> as data attributes and as an injected
 * `@page` rule the moment printing starts, and removed afterwards, so the
 * screen never changes.
 */
type Orientation = 'auto' | 'portrait' | 'landscape';
type Scale = 'fit' | 'actual';

const STORAGE_KEY = 'fid.print.options';
const WIDE_COLUMNS = 7;

function readOptions(): { orientation: Orientation; scale: Scale } {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<{ orientation: Orientation; scale: Scale }>) : {};
    return {
      orientation: parsed.orientation === 'portrait' || parsed.orientation === 'landscape' ? parsed.orientation : 'auto',
      scale: parsed.scale === 'actual' ? 'actual' : 'fit',
    };
  } catch {
    return { orientation: 'auto', scale: 'fit' };
  }
}

/** Landscape when any table on the page is wider than a portrait sheet reads well. */
function widestTableColumns(): number {
  let widest = 0;
  for (const table of document.querySelectorAll<HTMLTableElement>('main table')) {
    const header = table.querySelector('thead tr');
    const count = header
      ? [...header.children].filter((cell) => (cell as HTMLElement).dataset.print !== 'hide').length
      : 0;
    widest = Math.max(widest, count);
  }
  return widest;
}

export function printPage(options: { orientation: Orientation; scale: Scale }) {
  const orientation =
    options.orientation === 'auto' ? (widestTableColumns() > WIDE_COLUMNS ? 'landscape' : 'portrait') : options.orientation;
  const root = document.documentElement;
  root.dataset.printOrientation = orientation;
  root.dataset.printScale = options.scale;

  const style = document.createElement('style');
  style.setAttribute('data-print-page', '');
  style.textContent = `@page { size: A4 ${orientation}; margin: ${orientation === 'landscape' ? '8mm 8mm' : '10mm 9mm'}; }`;
  document.head.appendChild(style);

  const cleanup = () => {
    style.remove();
    delete root.dataset.printOrientation;
    delete root.dataset.printScale;
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  // Let the stylesheet apply before the dialogue snapshots the page.
  window.setTimeout(() => window.print(), 30);
}

export function PrintButton({ label = 'Print / PDF' }: { label?: string }) {
  // Read from storage on first render on the client; the server renders
  // the defaults, and the two agree because nothing is shown until opened.
  const [options, setOptions] = React.useState<{ orientation: Orientation; scale: Scale }>(() =>
    typeof window === 'undefined' ? { orientation: 'auto', scale: 'fit' } : readOptions(),
  );
  const [open, setOpen] = React.useState(false);

  function update(patch: Partial<typeof options>) {
    const next = { ...options, ...patch };
    setOptions(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Remembering is a convenience only.
    }
  }

  return (
    <span className="inline-flex" data-print="hide">
      <Button
        variant="outline"
        size="sm"
        onClick={() => printPage(options)}
        className="rounded-r-none"
        data-print="hide"
      >
        <Printer />
        {label}
      </Button>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button variant="outline" size="sm" className="-ml-px rounded-l-none px-2" aria-label="Print options" data-print="hide">
            <ChevronDown className="size-3.5" />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="end" sideOffset={6} className="z-50 w-64 rounded-xl border border-line bg-surface p-3 shadow-overlay">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Orientation</p>
            <div className="mb-3 grid grid-cols-3 gap-1" role="group" aria-label="Orientation">
              {(
                [
                  ['auto', 'Auto'],
                  ['portrait', 'Portrait'],
                  ['landscape', 'Landscape'],
                ] as const
              ).map(([value, text]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => update({ orientation: value })}
                  aria-pressed={options.orientation === value}
                  className={cn(
                    'rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                    options.orientation === value ? 'bg-forest-800 text-white' : 'border border-line text-ink-muted hover:text-ink',
                  )}
                >
                  {text}
                </button>
              ))}
            </div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Scale</p>
            <div className="mb-3 grid grid-cols-2 gap-1" role="group" aria-label="Scale">
              {(
                [
                  ['fit', 'Fit to width'],
                  ['actual', 'Actual size'],
                ] as const
              ).map(([value, text]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => update({ scale: value })}
                  aria-pressed={options.scale === value}
                  className={cn(
                    'rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                    options.scale === value ? 'bg-forest-800 text-white' : 'border border-line text-ink-muted hover:text-ink',
                  )}
                >
                  {text}
                </button>
              ))}
            </div>
            <p className="mb-3 text-[11px] text-ink-subtle">
              Auto chooses landscape for a wide table. Fit to width keeps every column on the sheet.
            </p>
            <Button
              size="sm"
              className="w-full"
              onClick={() => {
                setOpen(false);
                printPage(options);
              }}
            >
              <Printer />
              Print / Save as PDF
            </Button>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </span>
  );
}
