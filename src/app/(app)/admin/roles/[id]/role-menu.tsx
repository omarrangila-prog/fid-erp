'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { FormError } from '@/components/shared/form-error';
import { allNavItems } from '@/components/layout/nav-config';
import { saveRoleMenuAction } from '@/server/actions/admin-actions';

/**
 * The pages this role sees first, under "My pages" at the top of the menu,
 * in the order set here. It orders the menu only: a page the role has no
 * permission for stays hidden and refused, whatever is listed.
 */
export function RoleMenu({ roleId, initial }: { roleId: string; initial: string[] }) {
  const router = useRouter();
  const items = React.useMemo(() => allNavItems(), []);
  const byHref = React.useMemo(() => new Map(items.map((i) => [i.href, i])), [items]);
  const [pages, setPages] = React.useState(() => initial.filter((h) => byHref.has(h)));
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const groups = [...new Set(items.map((i) => i.group))];
  const move = (index: number, by: number) =>
    setPages((prev) => {
      const next = [...prev];
      const [page] = next.splice(index, 1);
      next.splice(index + by, 0, page);
      return next;
    });

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveRoleMenuAction(roleId, pages);
      if (result.ok) {
        toast.success('Menu saved.');
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <Card data-testid="role-menu">
      <CardHeader>
        <CardTitle>My pages — this role&rsquo;s menu</CardTitle>
        <CardDescription>
          Shown first in the sidebar of everyone with this role, in this order. It only orders the menu; what the role
          may open is the grid above.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {pages.length === 0 ? (
          <p className="text-sm text-ink-muted">No pages chosen — the role sees the usual menu.</p>
        ) : (
          <ol className="space-y-1">
            {pages.map((href, index) => (
              <li
                key={href}
                className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-sm"
                data-testid="role-menu-page"
              >
                <span className="w-5 text-xs text-ink-subtle">{index + 1}</span>
                <span className="flex-1">
                  {byHref.get(href)?.label}
                  <span className="ml-2 text-xs text-ink-subtle">{byHref.get(href)?.group}</span>
                </span>
                <button
                  type="button"
                  aria-label="Move up"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  className="rounded p-1 text-ink-muted hover:bg-surface-sunken disabled:opacity-30"
                >
                  <ArrowUp className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Move down"
                  disabled={index === pages.length - 1}
                  onClick={() => move(index, 1)}
                  className="rounded p-1 text-ink-muted hover:bg-surface-sunken disabled:opacity-30"
                >
                  <ArrowDown className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${byHref.get(href)?.label}`}
                  onClick={() => setPages((prev) => prev.filter((h) => h !== href))}
                  className="rounded p-1 text-ink-muted hover:bg-surface-sunken"
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ol>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Add a page"
            data-testid="role-menu-add"
            value=""
            onChange={(e) => {
              const href = e.target.value;
              if (href) setPages((prev) => (prev.includes(href) ? prev : [...prev, href]));
            }}
            className="w-72"
          >
            <option value="">+ Add a page…</option>
            {groups.map((group) => (
              <optgroup key={group} label={group}>
                {items
                  .filter((i) => i.group === group && !pages.includes(i.href))
                  .map((i) => (
                    <option key={i.href} value={i.href}>
                      {i.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </Select>
          <Button onClick={save} disabled={pending} data-testid="save-role-menu">
            {pending ? 'Saving…' : 'Save menu'}
          </Button>
        </div>
        <FormError message={error} />
      </CardContent>
    </Card>
  );
}
