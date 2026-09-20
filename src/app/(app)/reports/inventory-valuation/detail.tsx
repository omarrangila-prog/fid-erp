'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';

type Group = {
  key: string;
  heading: string;
  sub: string;
  href: string;
  closingKg: string;
  closingValue: string;
  movements: Array<{ key: string; date: string; type: string; warehouse: string; quantity: string; rate: string; cost: string; onHand: string; value: string }>;
};

/** Item / batch groups, each listing the movements with quantity and value after each. */
export function ValuationDetail({ groups, showCost }: { groups: Group[]; showCost: boolean }) {
  const [closed, setClosed] = React.useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div className="space-y-2">
      {groups.map((g) => {
        const shown = !closed.has(g.key);
        return (
          <section key={g.key} className="rounded-lg border border-line">
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <button type="button" onClick={() => toggle(g.key)} aria-expanded={shown} className="inline-flex items-center gap-1.5 text-left text-sm font-semibold text-ink">
                {shown ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                {g.heading}
                <span className="text-xs font-normal text-ink-muted">{g.sub}</span>
              </button>
              <span className="tnum text-xs text-ink-muted">
                On hand <span className="font-semibold text-ink">{g.closingKg}</span>
                {showCost ? <> · value <span className="font-semibold text-ink">{g.closingValue}</span></> : null}
                {' · '}
                <Link href={g.href} className="text-forest-800 hover:underline">
                  Open batch
                </Link>
              </span>
            </div>
            {shown ? (
              <div className="overflow-x-auto border-t border-line">
                <table className="w-full min-w-[44rem] text-xs">
                  <thead>
                    <tr className="text-left uppercase tracking-wider text-ink-muted">
                      <th className="px-3 py-1.5 font-medium">Date</th>
                      <th className="px-3 py-1.5 font-medium">Type</th>
                      <th className="px-3 py-1.5 font-medium">Warehouse</th>
                      <th className="px-3 py-1.5 text-right font-medium">Qty in / out</th>
                      {showCost ? (
                        <>
                          <th className="px-3 py-1.5 text-right font-medium">Rate</th>
                          <th className="px-3 py-1.5 text-right font-medium">Cost</th>
                        </>
                      ) : null}
                      <th className="px-3 py-1.5 text-right font-medium">Qty on hand</th>
                      {showCost ? <th className="px-3 py-1.5 text-right font-medium">Asset value</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {g.movements.map((m) => (
                      <tr key={m.key} className="border-t border-line/60">
                        <td className="whitespace-nowrap px-3 py-1.5">{m.date}</td>
                        <td className="px-3 py-1.5">{m.type}</td>
                        <td className="px-3 py-1.5">{m.warehouse}</td>
                        <td className="tnum px-3 py-1.5 text-right">{m.quantity}</td>
                        {showCost ? (
                          <>
                            <td className="tnum px-3 py-1.5 text-right">{m.rate}</td>
                            <td className="tnum px-3 py-1.5 text-right">{m.cost}</td>
                          </>
                        ) : null}
                        <td className="tnum px-3 py-1.5 text-right font-medium">{m.onHand}</td>
                        {showCost ? <td className="tnum px-3 py-1.5 text-right font-medium">{m.value}</td> : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
