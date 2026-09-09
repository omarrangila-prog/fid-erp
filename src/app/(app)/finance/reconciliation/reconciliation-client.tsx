'use client';

import * as React from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { CheckCircle2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select, MoneyInput } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Callout, EmptyState } from '@/components/ui/feedback';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { formatMoney } from '@/lib/format';
import { dec } from '@/lib/money';
import {
  openReconciliationAction,
  tickReconciliationLineAction,
  completeReconciliationAction,
} from '@/server/actions/compliance-actions';

export type ReconLine = {
  journalLineId: string;
  date: string;
  entryNumber: string;
  description: string;
  reference: string;
  amount: string;
  reconciled: boolean;
};

export type ReconWorkspace = {
  reconciliationId: string | null;
  isComplete: boolean;
  currency: string;
  accountName: string;
  lines: ReconLine[];
  bookBalance: string;
  reconciledBalance: string;
  statementBalance: string;
  difference: string;
  unclearedDeposits: string;
  unclearedPayments: string;
};

/**
 * Ticking the ledger against a bank statement.
 *
 * Every figure here is in the account's own currency — the currency the
 * statement is printed in — not the company's books currency. A USD account in
 * an AED company shows 6,000, never 22,035, because the person holding the
 * statement is comparing against 6,000.
 */
export function ReconciliationClient(props: {
  accounts: Array<{ id: string; name: string; currency: string }>;
  accountId: string;
  statementDate: string;
  workspace: ReconWorkspace | null;
}) {
  // Remounting when the statement changes resets the typed balance without an
  // effect, so a half-typed figure can never leak onto another account or date.
  return <ReconciliationBody key={`${props.accountId}:${props.statementDate}`} {...props} />;
}

function ReconciliationBody({
  accounts,
  accountId,
  statementDate,
  workspace,
}: {
  accounts: Array<{ id: string; name: string; currency: string }>;
  accountId: string;
  statementDate: string;
  workspace: ReconWorkspace | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [statementBalance, setStatementBalance] = React.useState(workspace?.statementBalance ?? '');
  const [busyLine, setBusyLine] = React.useState<string | null>(null);
  const [opening, setOpening] = React.useState(false);
  const [confirmComplete, setConfirmComplete] = React.useState(false);

  function navigate(patch: Record<string, string>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) next.set(key, value);
    router.push(`${pathname}?${next.toString()}`);
  }

  async function openStatement() {
    setOpening(true);
    try {
      const result = await openReconciliationAction(
        JSON.stringify({ cashBankAccountId: accountId, statementDate, statementBalance: statementBalance || '0' }),
      );
      if (result?.ok) {
        toast.success('Statement opened. Tick the lines the bank has cleared.');
        router.refresh();
      } else {
        toast.error(result?.error ?? 'The statement could not be opened.');
      }
    } finally {
      setOpening(false);
    }
  }

  async function tick(line: ReconLine, next: boolean) {
    if (!workspace?.reconciliationId) return;
    setBusyLine(line.journalLineId);
    try {
      const result = await tickReconciliationLineAction(workspace.reconciliationId, line.journalLineId, next);
      if (result.ok) router.refresh();
      else toast.error(result.error);
    } finally {
      setBusyLine(null);
    }
  }

  const difference = workspace ? dec(workspace.difference) : null;
  const balanced = difference !== null && difference.abs().lessThan('0.005');

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Which statement</CardTitle>
          <CardDescription>
            Choose the account and the closing date printed on the statement, then enter the closing balance.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field label="Account" required>
            <Select value={accountId} onChange={(event) => navigate({ account: event.target.value })}>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} ({account.currency})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Statement date" required>
            <Input type="date" value={statementDate} onChange={(event) => navigate({ date: event.target.value })} />
          </Field>
          <Field
            label={`Closing balance (${workspace?.currency ?? ''})`}
            required
            hint="Exactly as the bank shows it."
          >
            <div className="flex gap-2">
              <MoneyInput
                value={statementBalance}
                onChange={(event) => setStatementBalance(event.target.value)}
                disabled={workspace?.isComplete}
              />
              <Button variant="outline" loading={opening} onClick={openStatement} disabled={workspace?.isComplete}>
                {workspace?.reconciliationId ? 'Update' : 'Open'}
              </Button>
            </div>
          </Field>
        </CardContent>
      </Card>

      {!workspace ? null : workspace.isComplete ? (
        <Callout tone="info" title="Signed off">
          <span className="inline-flex items-center gap-1.5">
            <Lock className="size-3.5" />
            This statement has been reconciled and closed. The ticked lines can no longer be changed.
          </span>
        </Callout>
      ) : !workspace.reconciliationId ? (
        <Callout tone="info" title="Enter the closing balance to begin">
          Once the statement is open you can tick each line the bank has actually cleared. Anything left unticked is
          outstanding — a cheque written but not presented, a deposit not yet credited.
        </Callout>
      ) : null}

      {workspace ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryTile label="Statement balance" value={formatMoney(workspace.statementBalance, workspace.currency)} />
            <SummaryTile label="Ticked as cleared" value={formatMoney(workspace.reconciledBalance, workspace.currency)} />
            <SummaryTile
              label="Difference"
              value={formatMoney(workspace.difference, workspace.currency)}
              tone={balanced ? 'good' : 'bad'}
            />
            <SummaryTile
              label="Ledger balance"
              value={formatMoney(workspace.bookBalance, workspace.currency)}
              hint={`${formatMoney(workspace.unclearedDeposits, workspace.currency)} in and ${formatMoney(workspace.unclearedPayments, workspace.currency)} out not yet cleared`}
            />
          </div>

          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>Ledger lines up to {statementDate}</CardTitle>
                <CardDescription>
                  Tick every line that appears on the statement. Nothing here posts to the ledger — a genuine error is
                  fixed with a journal voucher, which leaves a trail.
                </CardDescription>
              </div>
              {workspace.reconciliationId && !workspace.isComplete ? (
                <Button
                  size="sm"
                  variant="accent"
                  disabled={!balanced}
                  title={balanced ? undefined : 'Reconcile to zero before signing off'}
                  onClick={() => setConfirmComplete(true)}
                >
                  <CheckCircle2 />
                  Sign off
                </Button>
              ) : null}
            </CardHeader>
            <CardContent className="px-0 sm:px-0">
              {workspace.lines.length === 0 ? (
                <div className="px-4 pb-4">
                  <EmptyState
                    title="Nothing has moved through this account yet"
                    description="Post a receipt, a payment or an expense against it and the lines will appear here."
                  />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <THead>
                      <TR>
                        <TH>Cleared</TH>
                        <TH>Date</TH>
                        <TH>Entry</TH>
                        <TH>Description</TH>
                        <TH numeric>In</TH>
                        <TH numeric>Out</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {workspace.lines.map((line) => {
                        const amount = dec(line.amount);
                        const isIn = amount.greaterThan(0);
                        return (
                          <TR key={line.journalLineId}>
                            <TD>
                              <input
                                type="checkbox"
                                checked={line.reconciled}
                                disabled={
                                  !workspace.reconciliationId ||
                                  workspace.isComplete ||
                                  busyLine === line.journalLineId
                                }
                                onChange={(event) => tick(line, event.target.checked)}
                                aria-label={`Mark ${line.entryNumber} as cleared`}
                                className="size-4 accent-forest-700"
                              />
                            </TD>
                            <TD>{line.date}</TD>
                            <TD>
                              <span className="block font-medium">{line.entryNumber}</span>
                              <span className="block text-xs text-ink-subtle">
                                {line.reference.replace(/_/g, ' ').toLowerCase()}
                              </span>
                            </TD>
                            <TD>{line.description}</TD>
                            <TD numeric>{isIn ? formatMoney(amount, workspace.currency) : '—'}</TD>
                            <TD numeric>{isIn ? '—' : formatMoney(amount.abs(), workspace.currency)}</TD>
                          </TR>
                        );
                      })}
                    </TBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}

      <ConfirmDialog
        open={confirmComplete}
        onOpenChange={setConfirmComplete}
        title="Sign off this reconciliation?"
        description="The ticked lines are locked against this statement and cannot be changed afterwards. Anything left unticked stays outstanding and carries forward to the next statement."
        confirmLabel="Sign off"
        onConfirm={async () => {
          if (!workspace?.reconciliationId) return;
          const result = await completeReconciliationAction(workspace.reconciliationId);
          if (result.ok) {
            toast.success('Reconciliation signed off.');
            router.refresh();
          } else {
            throw new Error(result.error);
          }
        }}
      />
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'good' | 'bad';
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs font-medium text-ink-muted">{label}</p>
      <p
        className={
          tone === 'good'
            ? 'mt-1 text-lg font-semibold tabular-nums text-emerald-700'
            : tone === 'bad'
              ? 'mt-1 text-lg font-semibold tabular-nums text-red-600'
              : 'mt-1 text-lg font-semibold tabular-nums text-ink'
        }
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-ink-subtle">{hint}</p> : null}
    </div>
  );
}
