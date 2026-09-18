'use client';

import * as React from 'react';
import { Combobox } from '@/components/ui/combobox';
import {
  AddJournalAccountDialog,
  type CreatedJournalAccount,
} from '@/app/(app)/accounting/journal/new/add-account';

/** How many of the last-used accounts to float to the top. */
const RECENT_LIMIT = 5;
const RECENT_KEY = 'fid.accounts.recent';

/**
 * The handful of accounts somebody actually uses, kept per browser.
 *
 * The same four or five names come up all day — the bank, the drawer, Dubai,
 * the agent — and scrolling past forty control accounts to reach them is the
 * friction this removes. Wrapped in try/catch because localStorage throws
 * rather than returns in a private window, and a selector that will not open
 * because it could not read a preference is worse than one with no memory.
 */
const NO_RECENT: string[] = [];

/** Cached so the snapshot is stable between renders, as the store requires. */
let recentCache: string[] = NO_RECENT;
let recentRaw: string | null = null;

function readRecent(): string[] {
  if (typeof window === 'undefined') return NO_RECENT;
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (raw === recentRaw) return recentCache;
    recentRaw = raw;
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    recentCache = Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string')
      : NO_RECENT;
    return recentCache;
  } catch {
    return NO_RECENT;
  }
}

/** Another tab choosing an account updates this one too. */
function subscribeRecent(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
}

function rememberRecent(accountId: string): string[] {
  const next = [accountId, ...readRecent().filter((id) => id !== accountId)].slice(0, RECENT_LIMIT);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Nothing to be done, and nothing that should stop the entry being made.
  }
  return next;
}

export type LedgerOption = {
  id: string;
  name: string;
  /** Null for a running account that holds whatever currency is used. */
  currency: string | null;
};

/**
 * Who the money is with — chosen from the ledgers, never typed.
 *
 * A name typed into a box is a name, and next month it is typed slightly
 * differently and the same person has two histories. An account is a thing:
 * pick Ahmed and every entry involving Ahmed lands in Ahmed's ledger, this
 * month and next.
 *
 * Somebody who is not on the list yet is not a dead end. Type the name, take
 * "Add New Account" at the bottom, and the ledger is opened and selected
 * without the form being lost — which is the whole reason people type names
 * into boxes instead.
 */
export function AccountSelect({
  id,
  accounts,
  value,
  onChange,
  defaultCurrency,
  placeholder = 'Search or type a name…',
}: {
  id?: string;
  accounts: LedgerOption[];
  value: string;
  onChange: (accountId: string) => void;
  /** The currency a newly created account should default to. */
  defaultCurrency: string;
  placeholder?: string;
}) {
  const [addOpen, setAddOpen] = React.useState(false);
  /*
   * Read on the client, once the component is interactive.
   *
   * The server has no localStorage, so reading it while rendering would give
   * one list on the server and another in the browser. useSyncExternalStore
   * is built for exactly this: the server snapshot is empty, the client's is
   * what was stored, and React reconciles the two without a mismatch.
   */
  const [recentOverride, setRecentOverride] = React.useState<string[] | null>(null);
  const storedRecent = React.useSyncExternalStore(subscribeRecent, readRecent, () => NO_RECENT);
  const recentIds = recentOverride ?? storedRecent;
  const [typedName, setTypedName] = React.useState('');
  const [created, setCreated] = React.useState<LedgerOption[]>([]);

  const all = React.useMemo(() => {
    const seen = new Set(accounts.map((a) => a.id));
    return [...accounts, ...created.filter((a) => !seen.has(a.id))];
  }, [accounts, created]);

  // The handful somebody uses every day, then everybody else.
  const options = React.useMemo(() => {
    const recent = recentIds
      .map((rid) => all.find((a) => a.id === rid))
      .filter((a): a is LedgerOption => Boolean(a));
    const rest = all.filter((a) => !recentIds.includes(a.id));
    const shape = (account: LedgerOption, group: string) => ({
      value: account.id,
      label: account.name,
      hint: account.currency ?? 'any currency',
      keywords: account.name,
      group,
    });
    // Only call it a section when there is something to put in it.
    return recent.length > 0
      ? [...recent.map((a) => shape(a, 'Recent')), ...rest.map((a) => shape(a, 'All accounts'))]
      : rest.map((a) => shape(a, ''));
  }, [all, recentIds]);

  return (
    <>
      <Combobox
        id={id}
        options={options}
        value={value}
        onChange={(next) => {
          const id = next ?? '';
          if (id) setRecentOverride(rememberRecent(id));
          onChange(id);
        }}
        placeholder={placeholder}
        emptyText="No account by that name yet"
        createLabel="+ Add New Account"
        onCreate={(query) => {
          setTypedName(query ?? '');
          setAddOpen(true);
        }}
      />

      <AddJournalAccountDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        initialName={typedName}
        defaultCurrency={defaultCurrency}
        onCreated={(account: CreatedJournalAccount) => {
          // Added to the list and selected, with the rest of the form intact.
          setCreated((existing) => [...existing, { id: account.id, name: account.name, currency: account.currency }]);
          setRecentOverride(rememberRecent(account.id));
          onChange(account.id);
          setAddOpen(false);
        }}
      />
    </>
  );
}
