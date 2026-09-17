'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import { FormError } from '@/components/shared/form-error';
import { Button } from '@/components/ui/button';
import { Input, MoneyInput, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { MasterSelect } from '@/components/shared/master-select';
import { vendorCreateSpec, cashBankCreateSpec, agentCreateSpec } from '@/components/shared/master-specs';
import { dec, tryDec } from '@/lib/money';
import { formatMoney, todayInputValue } from '@/lib/format';
import { accountsFor } from '@/lib/cash-account-choice';
import { saveSplitExpenseAction } from '@/server/actions/finance-actions';
import { useSaveAndOpen } from '@/lib/use-save-and-open';
import type { CategoryOption, ShipmentTrace } from '@/app/(app)/finance/expenses/expense-form';

/**
 * One payment, several cost categories.
 *
 * The header says everything about the money — when, from where or owed to
 * whom, in what currency. The lines say what it bought. Each line becomes an
 * expense in its own right, because in this business two categories on one
 * payment can be treated differently: port charges are capitalised into the
 * coffee, a staff dinner is not, and one record could not be both.
 *
 * Deliberately its own screen rather than a mode on the ordinary expense form.
 * That form carries the most rules in the application, and a second set of
 * line-level state inside it would be a second place for those rules to be
 * slightly wrong.
 */

type Line = {
  key: string;
  expenseCategoryId: string | null;
  description: string;
  amount: string;
  containerId: string | null;
  batchId: string | null;
};

const newLine = (): Line => ({
  key: Math.random().toString(36).slice(2),
  expenseCategoryId: null,
  description: '',
  amount: '',
  containerId: null,
  batchId: null,
});

export function SplitExpenseForm({
  categories,
  shipments,
  agents,
  vendors,
  accounts,
  localCurrency,
  defaultLocalRate,
  ratesByCurrency,
  traceByShipment = {},
  defaultShipmentId,
  canCreateCashBank = false,
}: {
  categories: CategoryOption[];
  shipments: ComboOption[];
  agents: ComboOption[];
  vendors: ComboOption[];
  accounts: Array<ComboOption & { currency: string; accountType: 'CASH' | 'PETTY_CASH' | 'BANK' }>;
  localCurrency: string;
  defaultLocalRate: string;
  ratesByCurrency: Record<string, string>;
  traceByShipment?: Record<string, ShipmentTrace>;
  defaultShipmentId?: string;
  canCreateCashBank?: boolean;
}) {
  const router = useRouter();
  const { busy, start, opening } = useSaveAndOpen();
  const [error, setError] = React.useState<string | null>(null);

  const [kind, setKind] = React.useState<'SHIPMENT' | 'GENERAL'>(defaultShipmentId ? 'SHIPMENT' : 'SHIPMENT');
  const [settlement, setSettlement] = React.useState<'PAID' | 'UNPAID'>('PAID');
  const [owedTo, setOwedTo] = React.useState<'VENDOR' | 'AGENT'>('VENDOR');

  const [header, setHeader] = React.useState({
    expenseDate: todayInputValue(),
    shipmentId: defaultShipmentId ?? (null as string | null),
    vendorId: null as string | null,
    payableToAgentId: null as string | null,
    currency: localCurrency,
    rateToUsd: localCurrency === 'USD' ? '1' : defaultLocalRate,
    rateLocalPerUsd: defaultLocalRate,
    paymentMethod: 'CASH' as 'CASH' | 'BANK_TRANSFER' | 'CHEQUE',
    cashBankAccountId: null as string | null,
    reference: '',
  });

  const [lines, setLines] = React.useState<Line[]>(() => [newLine(), newLine()]);

  const accountChoice = React.useMemo(
    () => accountsFor(accounts, header.paymentMethod, header.currency),
    [accounts, header.paymentMethod, header.currency],
  );
  const cashBankAccountId = accountChoice.automatic ?? header.cashBankAccountId;

  const availableCategories = categories.filter((c) => c.kind === kind);
  const trace = header.shipmentId ? traceByShipment[header.shipmentId] : undefined;

  const total = lines.reduce((sum, line) => {
    const value = tryDec(line.amount);
    return value ? sum.plus(value) : sum;
  }, dec(0));
  const isForeign = header.currency !== 'USD';

  function setLine(key: string, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function chooseCurrency(currency: string) {
    setHeader((prev) => ({
      ...prev,
      currency,
      rateToUsd: currency === 'USD' ? '1' : (ratesByCurrency[currency] ?? prev.rateToUsd),
      cashBankAccountId: null,
    }));
  }

  function submit() {
    setError(null);

    const filled = lines.filter((l) => l.expenseCategoryId || l.amount.trim());
    if (filled.length < 2) {
      setError('A split needs at least two lines. Use the ordinary expense form for a single category.');
      return;
    }
    for (const line of filled) {
      if (!line.expenseCategoryId) {
        setError('Every line needs a category.');
        return;
      }
      const amount = tryDec(line.amount);
      if (!amount || amount.lessThanOrEqualTo(0)) {
        setError('Every line needs an amount greater than zero.');
        return;
      }
    }
    if (kind === 'SHIPMENT' && !header.shipmentId) {
      setError('A shipment expense must name the contract / shipment it belongs to.');
      return;
    }
    if (settlement === 'PAID' && !cashBankAccountId) {
      setError('Choose the cash or bank this was paid from.');
      return;
    }
    if (settlement === 'UNPAID' && owedTo === 'VENDOR' && !header.vendorId) {
      setError('An unpaid cost has to say who is owed, so it can be aged and settled later.');
      return;
    }
    if (settlement === 'UNPAID' && owedTo === 'AGENT' && !header.payableToAgentId) {
      setError('An unpaid cost has to say who is owed, so it can be aged and settled later.');
      return;
    }

    start(async () => {
      const result = await saveSplitExpenseAction(
        JSON.stringify({
          expenseDate: header.expenseDate,
          kind,
          shipmentId: kind === 'SHIPMENT' ? (header.shipmentId ?? '') : '',
          vendorId: settlement === 'UNPAID' && owedTo === 'VENDOR' ? (header.vendorId ?? '') : '',
          agentId: '',
          payableToAgentId: settlement === 'UNPAID' && owedTo === 'AGENT' ? (header.payableToAgentId ?? '') : '',
          currency: header.currency,
          rateToUsd: isForeign ? header.rateToUsd : '1',
          rateLocalPerUsd: header.currency === localCurrency ? header.rateToUsd || '1' : header.rateLocalPerUsd,
          paymentMethod: header.paymentMethod,
          cashBankAccountId: settlement === 'PAID' ? (cashBankAccountId ?? '') : '',
          reference: header.reference,
          lines: filled.map((l) => ({
            expenseCategoryId: l.expenseCategoryId,
            description: l.description,
            amount: l.amount,
            containerId: kind === 'SHIPMENT' ? (l.containerId ?? '') : '',
            batchId: kind === 'SHIPMENT' ? (l.batchId ?? '') : '',
            taxCodeId: '',
          })),
        }),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(`${result.data.ids.length} expenses posted from one payment.`);
      opening();
      router.push('/finance/expenses');
    });
  }

  return (
    <div className="space-y-5">
      <FormError message={error} />

      <Card>
        <CardHeader>
          <CardTitle>The payment</CardTitle>
          <CardDescription>Said once. Every line below shares it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Type" required>
              <Select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value === 'GENERAL' ? 'GENERAL' : 'SHIPMENT');
                  setLines((prev) => prev.map((l) => ({ ...l, expenseCategoryId: null, containerId: null, batchId: null })));
                }}
              >
                <option value="SHIPMENT">Shipment expense</option>
                <option value="GENERAL">General company expense</option>
              </Select>
            </Field>

            {kind === 'SHIPMENT' ? (
              <Field label="Contract / shipment" required className="lg:col-span-2">
                <Combobox
                  options={shipments}
                  value={header.shipmentId}
                  onChange={(value) =>
                    setHeader((prev) => ({ ...prev, shipmentId: value }))
                  }
                  placeholder="Choose a shipment…"
                />
              </Field>
            ) : null}

            <Field label="Expense date" required>
              <Input
                type="date"
                value={header.expenseDate}
                onChange={(e) => setHeader((prev) => ({ ...prev, expenseDate: e.target.value }))}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Currency" required>
              <Select value={header.currency} onChange={(e) => chooseCurrency(e.target.value)}>
                {[...new Set(['USD', localCurrency, 'MAD', 'AED'])].map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            </Field>
            {isForeign ? (
              <Field label={`Rate (${header.currency} per 1 USD)`} required>
                <Input
                  inputMode="decimal"
                  value={header.rateToUsd}
                  onChange={(e) => setHeader((prev) => ({ ...prev, rateToUsd: e.target.value }))}
                />
              </Field>
            ) : null}
            <Field label="Reference" hint="One reference for the whole payment, e.g. the port receipt number.">
              <Input
                value={header.reference}
                onChange={(e) => setHeader((prev) => ({ ...prev, reference: e.target.value }))}
              />
            </Field>
            <Field label="Settlement" required>
              <Select
                value={settlement}
                onChange={(e) => setSettlement(e.target.value === 'UNPAID' ? 'UNPAID' : 'PAID')}
              >
                <option value="PAID">Paid</option>
                <option value="UNPAID">Unpaid — owed to someone</option>
              </Select>
            </Field>
          </div>

          {settlement === 'PAID' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Paid from" required>
                <Select
                  value={header.paymentMethod === 'CASH' ? 'CASH' : 'BANK'}
                  onChange={(e) =>
                    setHeader((prev) => ({
                      ...prev,
                      paymentMethod: e.target.value === 'CASH' ? 'CASH' : 'BANK_TRANSFER',
                      cashBankAccountId: null,
                    }))
                  }
                >
                  <option value="CASH">Cash in hand</option>
                  <option value="BANK">Bank</option>
                </Select>
              </Field>
              <Field
                label={header.paymentMethod === 'CASH' ? 'Cash account' : 'Bank account'}
                required
                hint={accountChoice.automatic ? 'Cash in Hand is selected for this currency.' : `Only ${header.currency} accounts are shown.`}
              >
                <MasterSelect
                  options={accountChoice.options}
                  value={cashBankAccountId}
                  onChange={(value) => setHeader((prev) => ({ ...prev, cashBankAccountId: value }))}
                  placeholder="Choose an account…"
                  emptyText={`No ${header.currency} account exists`}
                  create={
                    canCreateCashBank
                      ? cashBankCreateSpec(header.currency, header.paymentMethod === 'CASH' ? 'CASH' : 'BANK')
                      : undefined
                  }
                />
              </Field>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {kind === 'SHIPMENT' ? (
                <Field label="Owed to" required>
                  <Select value={owedTo} onChange={(e) => setOwedTo(e.target.value === 'AGENT' ? 'AGENT' : 'VENDOR')}>
                    <option value="VENDOR">A supplier</option>
                    <option value="AGENT">An agent</option>
                  </Select>
                </Field>
              ) : null}
              {owedTo === 'VENDOR' ? (
                <Field label="Supplier" required className={kind === 'GENERAL' ? 'sm:col-span-2' : undefined}>
                  <MasterSelect
                    options={vendors}
                    value={header.vendorId}
                    onChange={(value) => setHeader((prev) => ({ ...prev, vendorId: value }))}
                    placeholder="Choose a supplier…"
                    create={vendorCreateSpec(header.currency)}
                  />
                </Field>
              ) : (
                <Field label="Agent" required>
                  <MasterSelect
                    options={agents}
                    value={header.payableToAgentId}
                    onChange={(value) => setHeader((prev) => ({ ...prev, payableToAgentId: value }))}
                    placeholder="Choose an agent…"
                    create={agentCreateSpec()}
                  />
                </Field>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>What it paid for</CardTitle>
            <CardDescription>One line per category. Each becomes its own expense, sharing the payment above.</CardDescription>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, newLine()])}>
            <Plus />
            Add line
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {lines.map((line, index) => (
            <div
              key={line.key}
              className="grid gap-3 rounded-xl border border-line p-3 sm:grid-cols-2 lg:grid-cols-[2fr_2fr_1fr_1fr_1fr_auto]"
            >
              <Field label={index === 0 ? 'Category' : undefined}>
                <Combobox
                  aria-label={`Category on line ${index + 1}`}
                  options={availableCategories}
                  value={line.expenseCategoryId}
                  onChange={(value) => setLine(line.key, { expenseCategoryId: value })}
                  placeholder="Choose…"
                />
              </Field>
              <Field label={index === 0 ? 'Description' : undefined}>
                <Input
                  aria-label={`Description on line ${index + 1}`}
                  value={line.description}
                  onChange={(e) => setLine(line.key, { description: e.target.value })}
                />
              </Field>
              {kind === 'SHIPMENT' ? (
                <>
                  <Field label={index === 0 ? 'Container' : undefined}>
                    <Select
                      aria-label={`Container on line ${index + 1}`}
                      value={line.containerId ?? ''}
                      onChange={(e) => setLine(line.key, { containerId: e.target.value || null, batchId: null })}
                      disabled={!trace || trace.containers.length === 0}
                    >
                      <option value="">All</option>
                      {(trace?.containers ?? []).map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={index === 0 ? 'Batch' : undefined}>
                    <Select
                      aria-label={`Batch on line ${index + 1}`}
                      value={line.batchId ?? ''}
                      onChange={(e) => setLine(line.key, { batchId: e.target.value || null })}
                      disabled={!trace || trace.batches.length === 0}
                    >
                      <option value="">All</option>
                      {(trace?.batches ?? [])
                        .filter((b) => !line.containerId || b.containerId === line.containerId)
                        .map((b) => (
                          <option key={b.value} value={b.value}>
                            {b.label}
                          </option>
                        ))}
                    </Select>
                  </Field>
                </>
              ) : (
                <div className="hidden lg:col-span-2 lg:block" />
              )}
              <Field label={index === 0 ? `Amount (${header.currency})` : undefined}>
                <MoneyInput
                  aria-label={`Amount on line ${index + 1}`}
                  value={line.amount}
                  onChange={(e) => setLine(line.key, { amount: e.target.value })}
                />
              </Field>
              <div className={index === 0 ? 'flex items-end' : 'flex items-end'}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove line ${index + 1}`}
                  disabled={lines.length <= 2}
                  onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))}

          <div className="flex items-center justify-end gap-3 border-t border-line pt-3 text-sm">
            <span className="text-ink-muted">Total</span>
            <span className="text-lg font-semibold tabular-nums">{formatMoney(total, header.currency)}</span>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={() => router.back()} disabled={busy}>
          Cancel
        </Button>
        <Button variant="accent" onClick={submit} loading={busy}>
          Post all lines
        </Button>
      </div>
    </div>
  );
}
