'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { FormError } from '@/components/shared/form-error';
import { GRID_ACTIONS, GRID_PAGES, OTHER_ACTION_LABEL } from '@/lib/permission-grid';
import type { ActionResult } from '@/server/actions/action-utils';

/**
 * Tick a page's View, Create, Edit and Delete independently, and its other
 * actions beside them. Unticking View also clears the rest of the row — a
 * page that cannot be opened cannot be edited either.
 */
export function RoleGrid({
  save: saveCodes,
  granted,
  baseline,
  permissions,
}: {
  /** A server action already bound to the role or the person. */
  save: (codes: string[]) => Promise<ActionResult<undefined>>;
  granted: string[];
  /** For one person: what their role gives, so a tick that differs from it is marked. */
  baseline?: string[];
  permissions: Array<{ code: string; description: string }>;
}) {
  const router = useRouter();
  const [ticked, setTicked] = React.useState(() => new Set(granted));
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const known = new Map(permissions.map((p) => [p.code, p.description]));
  const base = baseline ? new Set(baseline) : null;
  const differs = (code: string) => base !== null && base.has(code) !== ticked.has(code);

  const toggle = (code: string, on: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(code);
      else next.delete(code);
      // Without View nothing else on the page makes sense.
      const [page, action] = code.split('.');
      if (!on && action === 'view') for (const c of [...next]) if (c.startsWith(`${page}.`)) next.delete(c);
      if (on && action !== 'view' && known.has(`${page}.view`)) next.add(`${page}.view`);
      return next;
    });

  const rows = GRID_PAGES.map((page) => {
    const codes = permissions.filter((p) => p.code.startsWith(`${page.key}.`)).map((p) => p.code);
    return { ...page, codes };
  }).filter((row) => row.codes.length > 0);
  // Anything the grid does not name still shows, at the bottom.
  const placed = new Set(rows.flatMap((r) => r.codes));
  const leftover = permissions.filter((p) => !placed.has(p.code));

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveCodes([...ticked]);
      if (result.ok) {
        toast.success('Permissions saved.');
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div className="space-y-4">
      <TableWrap>
        <Table data-testid="role-grid">
          <THead>
            <TR className="hover:bg-transparent">
              <TH>Page</TH>
              {GRID_ACTIONS.map((a) => (
                <TH key={a} className="text-center capitalize">
                  {a}
                </TH>
              ))}
              <TH>Other</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((row, index) => {
              const section = index === 0 || rows[index - 1].section !== row.section ? row.section : null;
              const others = row.codes.filter((c) => !GRID_ACTIONS.includes(c.split('.')[1] as never));
              return (
                <React.Fragment key={row.key}>
                  {section ? (
                    <TR className="bg-surface-sunken/60 hover:bg-surface-sunken/60">
                      <TD colSpan={6} className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                        {section}
                      </TD>
                    </TR>
                  ) : null}
                  <TR data-testid={`grid-row-${row.key}`}>
                    <TD className="font-medium">{row.label}</TD>
                    {GRID_ACTIONS.map((action) => {
                      const code = `${row.key}.${action}`;
                      return (
                        <TD key={action} className="text-center">
                          {known.has(code) ? (
                            <span className="relative inline-flex">
                              <input
                                type="checkbox"
                                aria-label={`${row.label}: ${action}`}
                                title={
                                  differs(code)
                                    ? `${known.get(code)} — changed for this person (the role says ${base!.has(code) ? 'yes' : 'no'})`
                                    : known.get(code)
                                }
                                checked={ticked.has(code)}
                                onChange={(e) => toggle(code, e.target.checked)}
                                className="size-4 accent-forest-700"
                              />
                              {differs(code) ? (
                                <span className="absolute -right-2 -top-1 size-1.5 rounded-full bg-gold-500" data-testid="grid-override" />
                              ) : null}
                            </span>
                          ) : (
                            <span className="text-ink-subtle">—</span>
                          )}
                        </TD>
                      );
                    })}
                    <TD>
                      <span className="flex flex-wrap gap-3">
                        {others.map((code) => (
                          <label key={code} className="flex items-center gap-1.5 text-xs" title={known.get(code)}>
                            <input
                              type="checkbox"
                              aria-label={`${row.label}: ${code.split('.')[1]}`}
                              checked={ticked.has(code)}
                              onChange={(e) => toggle(code, e.target.checked)}
                              className="size-4 accent-forest-700"
                            />
                            {OTHER_ACTION_LABEL[code.split('.')[1]] ?? code.split('.')[1]}
                          </label>
                        ))}
                      </span>
                    </TD>
                  </TR>
                </React.Fragment>
              );
            })}
            {leftover.length ? (
              <TR>
                <TD className="font-medium">Other</TD>
                <TD colSpan={5}>
                  <span className="flex flex-wrap gap-3">
                    {leftover.map((p) => (
                      <label key={p.code} className="flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={ticked.has(p.code)}
                          onChange={(e) => toggle(p.code, e.target.checked)}
                          className="size-4 accent-forest-700"
                        />
                        {p.description}
                      </label>
                    ))}
                  </span>
                </TD>
              </TR>
            ) : null}
          </TBody>
        </Table>
      </TableWrap>
      <FormError message={error} />
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => setTicked(new Set(granted))} disabled={pending}>
          Undo changes
        </Button>
        <Button onClick={save} loading={pending} data-testid="save-role-grid">
          Save permissions
        </Button>
      </div>
    </div>
  );
}
