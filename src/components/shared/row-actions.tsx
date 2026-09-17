'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  MoreHorizontal, Eye, Pencil, Trash2, BookOpen, HandCoins, ArrowDownToLine, ArrowUpFromLine,
  FileText, Printer, ArrowLeftRight, History, Layers, Ship, PackageCheck, Calculator, ShoppingCart,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/ui/confirm';

/**
 * One action pattern for every table in the application.
 *
 * The client's complaint was that Edit and Delete lived in a different place
 * on every screen — a three-dot menu here, a hover button there, and on some
 * screens nowhere at all until the row had been opened. Every list now uses
 * this: the first few actions as compact buttons that are always visible, the
 * rest behind one overflow menu, in the same order, in a column pinned to the
 * right of the sheet.
 *
 * Destroying a posted financial document is never on offer. `destructive`
 * carries the document's status: a draft is deleted, anything posted is
 * deleted — which takes it back out of the books and keeps the trail — and either way the
 * user is asked first and the reason goes on the audit trail.
 */

/**
 * Icons a server-rendered row may ask for by name.
 *
 * A Server Component cannot hand a Client Component a function, and a React
 * icon is one — passing `icon: BookOpen` from a page crashed the render with
 * "Functions cannot be passed directly to Client Components". So a row built
 * on the server names its icon and the client resolves it here; a row built
 * in a client component can still pass the component itself.
 */
export const ROW_ACTION_ICONS = {
  view: Eye,
  edit: Pencil,
  ledger: BookOpen,
  money: HandCoins,
  moneyIn: ArrowDownToLine,
  moneyOut: ArrowUpFromLine,
  document: FileText,
  print: Printer,
  transfer: ArrowLeftRight,
  history: History,
  layers: Layers,
  ship: Ship,
  receive: PackageCheck,
  costing: Calculator,
  cart: ShoppingCart,
} as const;

export type RowActionIcon = keyof typeof ROW_ACTION_ICONS;

export type RowAction = {
  label: string;
  /** A link for navigation, or `onSelect` for something that happens here. */
  href?: string;
  onSelect?: () => void;
  /** A component (client only) or a name from ROW_ACTION_ICONS (anywhere). */
  icon?: React.ComponentType<{ className?: string }> | RowActionIcon;
  /** Hidden entirely when false — used for permissions. */
  show?: boolean;
  disabled?: boolean;
  /** Keep out of the always-visible buttons even if there is room. */
  overflowOnly?: boolean;
};

export type DestructiveAction = {
  /** What the row is now. A draft is removed; a posted row is taken back out of the books. */
  status: string;
  /** The noun, for the dialog: "invoice", "payment", "supplier". */
  noun: string;
  run: (reason?: string) => Promise<{ ok: boolean; error?: string }>;
  show?: boolean;
  /** Overrides for records that are not financial documents. */
  deleteLabel?: string;
  cancelLabel?: string;
  /** Extra sentence explaining what deleting this particular thing does. */
  description?: string;
};

const DRAFT_STATUSES = new Set(['DRAFT', 'PENDING', 'NEW', '']);

export function RowActions({
  actions,
  destructive,
  /** How many actions stay visible as buttons before the rest fold away. */
  inline = 2,
  className,
}: {
  actions: RowAction[];
  destructive?: DestructiveAction;
  inline?: number;
  className?: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const available = actions.filter((a) => a.show !== false);
  const visible = available.filter((a) => !a.overflowOnly).slice(0, inline);
  const folded = available.filter((a) => !visible.includes(a));

  const isDraft = destructive ? DRAFT_STATUSES.has(destructive.status.toUpperCase()) : false;
  const destructiveLabel = destructive
    ? isDraft
      ? (destructive.deleteLabel ?? 'Delete')
      : (destructive.cancelLabel ?? 'Delete')
    : null;
  const showDestructive = destructive && destructive.show !== false;

  async function runDestructive(reason?: string) {
    if (!destructive) return;
    setBusy(true);
    try {
      const result = await destructive.run(reason);
      if (!result.ok) throw new Error(result.error ?? `The ${destructive.noun} could not be deleted.`);
      toast.success(isDraft ? `Draft ${destructive.noun} deleted.` : `${destructive.noun[0].toUpperCase()}${destructive.noun.slice(1)} deleted.`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (available.length === 0 && !showDestructive) return null;

  return (
    <>
      <div className={cn('flex items-center justify-end gap-1', className)}>
        {visible.map((action) => (
          <ActionButton key={action.label} action={action} />
        ))}

        {folded.length > 0 || showDestructive ? (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                aria-label="More actions"
                className="tap-target inline-flex size-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={4}
                className="z-50 min-w-44 rounded-lg border border-line bg-surface p-1 shadow-overlay"
                onClick={(e) => e.stopPropagation()}
              >
                {folded.map((action) => (
                  <MenuItem key={action.label} action={action} />
                ))}
                {folded.length > 0 && showDestructive ? (
                  <DropdownMenu.Separator className="my-1 h-px bg-line" />
                ) : null}
                {showDestructive ? (
                  <DropdownMenu.Item
                    disabled={busy}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-red-700 outline-none data-[highlighted]:bg-red-50 data-[disabled]:opacity-50"
                    onSelect={(event) => {
                      event.preventDefault();
                      setConfirming(true);
                    }}
                  >
                    <Trash2 className="size-4" />
                    {destructiveLabel}
                  </DropdownMenu.Item>
                ) : null}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : null}
      </div>

      {destructive && showDestructive ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={isDraft ? `Delete this draft ${destructive.noun}?` : `Delete this ${destructive.noun}?`}
          description={
            isDraft
              ? `A draft has not reached the books, so it can simply be removed.`
              : (destructive.description ??
                `This ${destructive.noun} is posted, so deleting it also takes it back out of the books: stock, balances and the ledger are put back as they were. It disappears from every list and total. The audit log keeps a record of who deleted it and why.`)
          }
          confirmLabel="Yes, delete"
          variant="danger"
          requireReason={!isDraft}
          reasonLabel={`Why is this ${destructive.noun} being deleted?`}
          onConfirm={runDestructive}
        />
      ) : null}
    </>
  );
}

/**
 * Renders the icon a row asked for, by name or by component.
 *
 * Resolving it into a local `const Icon` and rendering that reads to React's
 * lint as creating a component during render, so the lookup lives inside a
 * component of its own.
 */
function ActionIcon({ icon, className }: { icon: RowAction['icon']; className: string }) {
  if (!icon) return null;
  const Resolved = typeof icon === 'string' ? ROW_ACTION_ICONS[icon] : icon;
  return <Resolved className={className} />;
}

function ActionButton({ action }: { action: RowAction }) {
  const content = (
    <>
      <ActionIcon icon={action.icon} className="size-3.5" />
      {action.label}
    </>
  );
  const className =
    'tap-target inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs font-medium text-ink-muted transition-colors hover:border-forest-300 hover:text-forest-800 disabled:opacity-40';

  if (action.href && !action.disabled) {
    return (
      <Link href={action.href} className={className} onClick={(e) => e.stopPropagation()}>
        {content}
      </Link>
    );
  }
  return (
    <button
      type="button"
      className={className}
      disabled={action.disabled}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        action.onSelect?.();
      }}
    >
      {content}
    </button>
  );
}

function MenuItem({ action }: { action: RowAction }) {
  const className =
    'flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface-sunken data-[disabled]:opacity-50';

  if (action.href && !action.disabled) {
    return (
      <DropdownMenu.Item asChild>
        <Link href={action.href} className={className}>
          <ActionIcon icon={action.icon} className="size-4" />
          {action.label}
        </Link>
      </DropdownMenu.Item>
    );
  }
  return (
    <DropdownMenu.Item
      disabled={action.disabled}
      className={className}
      onSelect={(event) => {
        event.preventDefault();
        action.onSelect?.();
      }}
    >
      <ActionIcon icon={action.icon} className="size-4" />
      {action.label}
    </DropdownMenu.Item>
  );
}

/** The two every row has, so no screen has to spell them out. */
export const viewAction = (href: string): RowAction => ({ label: 'View', href, icon: Eye });
export const editAction = (href: string, show = true): RowAction => ({
  label: 'Edit',
  href,
  icon: Pencil,
  show,
});
