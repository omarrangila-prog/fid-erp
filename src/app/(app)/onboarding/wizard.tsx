'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, ChevronLeft, ChevronRight, Download, Plus, PackageOpen, PackageCheck, ArrowLeftRight, Store, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Field, FieldGroup } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Callout } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import { CURRENCIES } from '@/lib/currencies';
import { saveExchangeRateAction, saveCompanyProfileAction } from '@/server/actions/company-actions';
import {
  addCashBankAccountAction,
  addWarehouseAction,
  commitImportAction,
  completeOnboardingAction,
  inviteUserAction,
  previewImportAction,
  saveBasicsAction,
  saveTaxSetupAction,
  type ImportPreview,
} from '@/server/actions/onboarding-actions';

type Props = {
  product: string;
  company: {
    name: string;
    country: string;
    countryCode: string;
    localCurrency: string;
    timezone: string;
    businessType: string;
    industryTemplate: string;
    unit: string;
    taxEnabled: boolean;
    taxLabel: string;
    hasLogo: boolean;
    locked: boolean;
    pending: boolean;
  };
  warehouses: Array<{ name: string; location: string | null }>;
  accounts: Array<{ name: string; accountType: string; currency: string }>;
  roles: Array<{ id: string; name: string; description: string | null }>;
  hasRate: boolean;
  taxRates: number;
  canInvite: boolean;
  options: {
    countries: Array<{ name: string; currency: string; timezone: string; taxLabel: string }>;
    templates: Array<{ key: string; label: string; description: string; businessType: string }>;
    businessTypes: Array<{ value: string; label: string }>;
    imports: Array<{ kind: string; label: string; description: string }>;
  };
};

const BUSINESS_INFO: Record<string, { icon: React.ComponentType<{ className?: string }>; text: string }> = {
  IMPORT: { icon: PackageOpen, text: 'Buy from overseas suppliers, land and sell locally.' },
  EXPORT: { icon: PackageCheck, text: 'Source locally or abroad and ship to overseas buyers.' },
  IMPORT_EXPORT: { icon: ArrowLeftRight, text: 'Both directions, with landed cost on every shipment.' },
  LOCAL_TRADING: { icon: Store, text: 'Buy and sell within one country, no shipments to track.' },
  DISTRIBUTION: { icon: Truck, text: 'Stock from principals and sell on to retailers and trade.' },
};

const STEPS = [
  { key: 'company', title: 'Your company', hint: 'Names and contact details' },
  { key: 'country', title: 'Country & currency', hint: 'Where you trade and what the books are kept in' },
  { key: 'business', title: 'How you trade', hint: 'Import, export, distribution…' },
  { key: 'industry', title: 'Your products', hint: 'Industry and how stock is counted' },
  { key: 'warehouses', title: 'Warehouses', hint: 'Where stock is kept' },
  { key: 'banks', title: 'Banks & cash', hint: 'Where money moves through' },
  { key: 'taxes', title: 'Taxes', hint: 'Registration and rates' },
  { key: 'users', title: 'Your team', hint: 'Who else signs in' },
  { key: 'data', title: 'Bring your data', hint: 'Items, customers, opening balances' },
  { key: 'done', title: 'Start using it', hint: '' },
] as const;

export function OnboardingWizard(props: Props) {
  const router = useRouter();
  const { company, options } = props;
  const [index, setIndex] = React.useState(0);
  const step = STEPS[index];
  const [busy, setBusy] = React.useState(false);

  const [basics, setBasics] = React.useState({
    country: company.country,
    localCurrency: company.localCurrency,
    timezone: company.timezone,
    businessType: company.businessType,
    industryTemplate: company.industryTemplate,
    unit: ['KG', 'PCS', 'M', 'L'].includes(company.unit) ? company.unit : 'PCS',
  });

  async function guard<T>(fn: () => Promise<{ ok: boolean; error?: string } & T>, success?: string): Promise<boolean> {
    setBusy(true);
    try {
      const result = await fn();
      if (result.ok) {
        if (success) toast.success(success);
        return true;
      }
      toast.error(result.error ?? 'That could not be saved.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const next = () => setIndex((i) => Math.min(STEPS.length - 1, i + 1));
  const back = () => setIndex((i) => Math.max(0, i - 1));

  async function finish() {
    if (await guard(() => completeOnboardingAction(), 'You are all set.')) {
      router.push('/dashboard');
      router.refresh();
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6" data-testid="onboarding">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-forest-700">{props.product}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">Set up {company.name}</h1>
        <p className="mt-1 text-sm text-ink-muted">Ten short steps. Skip any of them and come back later from Settings — nothing here is permanent.</p>
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={index + 1} aria-label="Setup progress">
        <div className="h-full rounded-full bg-forest-900 transition-[width] duration-200" style={{ width: `${((index + 1) / STEPS.length) * 100}%` }} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[15rem_1fr]">
      <ol className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:gap-0.5 lg:overflow-visible" aria-label="Setup steps">
        {STEPS.map((s, i) => (
          <li key={s.key} className="shrink-0 lg:shrink">
            <button
              type="button"
              onClick={() => setIndex(i)}
              aria-current={i === index ? 'step' : undefined}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                i === index ? 'bg-forest-900 font-semibold text-white' : 'text-ink-muted hover:bg-forest-50',
              )}
            >
              <span className={cn('grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold', i === index ? 'bg-white/15 text-white' : i < index ? 'bg-forest-700 text-white' : 'border border-line-strong text-ink-subtle')}>
                {i < index ? <Check className="size-3.5" /> : String(i + 1).padStart(2, '0')}
              </span>
              <span className="whitespace-nowrap lg:whitespace-normal">{s.title}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="min-w-0 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>
            {index + 1}. {step.title}
          </CardTitle>
          {step.hint ? <CardDescription>{step.hint}</CardDescription> : null}
        </CardHeader>
        <CardContent className="space-y-5">
          {step.key === 'company' ? <CompanyStep name={company.name} busy={busy} onSave={(fd) => guard(() => saveCompanyProfileAction(fd), 'Saved.')} /> : null}

          {step.key === 'country' ? (
            <>
              <FieldGroup className="sm:grid-cols-2">
                <Field label="Country" htmlFor="ob-country" required>
                  <Select
                    id="ob-country"
                    value={basics.country}
                    disabled={company.locked}
                    onChange={(e) => {
                      const c = options.countries.find((x) => x.name === e.target.value);
                      setBasics((b) => ({ ...b, country: e.target.value, localCurrency: c?.currency ?? b.localCurrency, timezone: c?.timezone ?? b.timezone }));
                    }}
                  >
                    {[...new Set([basics.country, ...options.countries.map((c) => c.name)])].map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Books are kept in" htmlFor="ob-currency" required hint={company.locked ? 'Locked: entries have been posted.' : 'Every figure is reported in this currency. It cannot change after the first entry.'}>
                  <Select id="ob-currency" value={basics.localCurrency} disabled={company.locked} onChange={(e) => setBasics((b) => ({ ...b, localCurrency: e.target.value }))}>
                    {CURRENCIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code} — {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Time zone" htmlFor="ob-tz">
                  <Input id="ob-tz" value={basics.timezone} onChange={(e) => setBasics((b) => ({ ...b, timezone: e.target.value }))} />
                </Field>
              </FieldGroup>
              <RateBox currency={basics.localCurrency} done={props.hasRate} />
            </>
          ) : null}

          {step.key === 'business' ? (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {options.businessTypes.map((b) => (
                <button
                  key={b.value}
                  type="button"
                  onClick={() => setBasics((s) => ({ ...s, businessType: b.value }))}
                  aria-pressed={basics.businessType === b.value}
                  className={cn('rounded-xl border p-4 text-left transition-colors', basics.businessType === b.value ? 'border-forest-700 bg-forest-50 ring-1 ring-forest-700' : 'border-line hover:bg-forest-50/40')}
                >
                  {(() => { const Info = BUSINESS_INFO[b.value]; return Info ? <Info.icon className="size-5 text-forest-700" /> : null; })()}
                  <span className="mt-2 block text-sm font-semibold text-ink">{b.label}</span>
                  <span className="mt-1 block text-xs text-ink-muted">{BUSINESS_INFO[b.value]?.text}</span>
                </button>
              ))}
            </div>
          ) : null}

          {step.key === 'industry' ? (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                {options.templates.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setBasics((s) => ({ ...s, industryTemplate: t.key, businessType: s.businessType || t.businessType, unit: t.key === 'COMMODITY_TRADING' ? 'KG' : s.unit }))}
                    className={cn('rounded-xl border p-4 text-left', basics.industryTemplate === t.key ? 'border-forest-600 bg-forest-50' : 'border-line hover:bg-forest-50/40')}
                  >
                    <span className="block text-sm font-semibold">{t.label}</span>
                    <span className="mt-1 block text-xs text-ink-muted">{t.description}</span>
                  </button>
                ))}
              </div>
              <Field label="Stock is counted in" htmlFor="ob-unit" hint="The unit quantities, costs and stock reports use. Individual items can differ.">
                <Select id="ob-unit" value={basics.unit} onChange={(e) => setBasics((b) => ({ ...b, unit: e.target.value }))}>
                  <option value="PCS">Pieces (PCS)</option>
                  <option value="KG">Kilograms (KG)</option>
                  <option value="M">Metres (M)</option>
                  <option value="L">Litres (L)</option>
                </Select>
              </Field>
            </>
          ) : null}

          {step.key === 'warehouses' ? <WarehouseStep existing={props.warehouses} onAdd={(v) => guard(() => addWarehouseAction(v), 'Warehouse added.').then((ok) => ok && router.refresh())} /> : null}
          {step.key === 'banks' ? (
            <BankStep existing={props.accounts} local={company.localCurrency} onAdd={(v) => guard(() => addCashBankAccountAction(v), 'Account added.').then((ok) => ok && router.refresh())} />
          ) : null}
          {step.key === 'taxes' ? <TaxStep label={company.taxLabel} enabled={company.taxEnabled} rates={props.taxRates} onSave={(v) => guard(() => saveTaxSetupAction(v), 'Tax saved.').then((ok) => ok && router.refresh())} /> : null}
          {step.key === 'users' ? <UsersStep roles={props.roles} allowed={props.canInvite} /> : null}
          {step.key === 'data' ? <DataStep imports={options.imports} /> : null}
          {step.key === 'done' ? (
            <div className="space-y-3">
              <p className="text-sm text-ink-muted">That is everything the system needs to start. You can change any of it later under Settings.</p>
              <ul className="grid gap-2 text-sm sm:grid-cols-2">
                {[
                  ['Create a purchase order', '/purchases/new'],
                  ['Add your first customer', '/customers?new=1'],
                  ['Receive stock into a warehouse', '/goods-receipts'],
                  ['See your dashboard', '/dashboard'],
                ].map(([label, href]) => (
                  <li key={href}>
                    <Link href={href} className="flex items-center justify-between rounded-lg border border-line px-3 py-2 hover:bg-forest-50">
                      {label}
                      <ChevronRight className="size-4 text-ink-subtle" />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <Button variant="outline" onClick={back} disabled={index === 0 || busy}>
          <ChevronLeft /> Back
        </Button>
        <div className="flex gap-2">
          {step.key === 'done' ? (
            <Button onClick={finish} disabled={busy} data-testid="start-using">
              Start using {props.product}
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={next} disabled={busy}>
                Skip for now
              </Button>
              <Button
                onClick={async () => {
                  if (['country', 'business', 'industry'].includes(step.key)) {
                    if (!(await guard(() => saveBasicsAction(basics), 'Saved.'))) return;
                    router.refresh();
                  }
                  next();
                }}
                disabled={busy}
              >
                Continue <ChevronRight />
              </Button>
            </>
          )}
        </div>
      </div>
      </div>
      </div>
    </div>
  );
}

function CompanyStep({ name, onSave, busy }: { name: string; busy: boolean; onSave: (fd: FormData) => Promise<boolean> }) {
  return (
    <form
      action={async (fd) => {
        await onSave(fd);
      }}
      className="space-y-4"
    >
      <FieldGroup className="sm:grid-cols-2">
        <Field label="Company name" htmlFor="ob-name" required>
          <Input id="ob-name" name="name" defaultValue={name} required />
        </Field>
        <Field label="Legal name" htmlFor="ob-legal" hint="Printed on invoices.">
          <Input id="ob-legal" name="legalName" />
        </Field>
        <Field label="Address" htmlFor="ob-address" className="sm:col-span-2">
          <Input id="ob-address" name="address" />
        </Field>
        <Field label="Phone" htmlFor="ob-phone">
          <Input id="ob-phone" name="phone" />
        </Field>
        <Field label="Email" htmlFor="ob-email">
          <Input id="ob-email" name="email" type="email" />
        </Field>
        <Field label="Company registration no." htmlFor="ob-reg">
          <Input id="ob-reg" name="companyRegistration" />
        </Field>
        <Field label="Website" htmlFor="ob-web">
          <Input id="ob-web" name="website" />
        </Field>
      </FieldGroup>
      <input type="hidden" name="dateFormat" value="DD MMM YYYY" />
      <input type="hidden" name="numberLocale" value="en-US" />
      <input type="hidden" name="timezone" value="UTC" />
      <p className="text-xs text-ink-subtle">Add your logo and the date and number style any time under Settings → Company profile.</p>
      <Button type="submit" variant="outline" disabled={busy}>
        Save company details
      </Button>
    </form>
  );
}

function RateBox({ currency, done }: { currency: string; done: boolean }) {
  const router = useRouter();
  const [rate, setRate] = React.useState('');
  if (currency === 'USD') return <Callout tone="info" title="The dollar is the reference">No exchange rate is needed for a company that keeps its books in US dollars.</Callout>;
  return (
    <div className="rounded-xl border border-line p-4">
      <p className="text-sm font-medium text-ink">Today’s rate for {currency}</p>
      <p className="text-xs text-ink-subtle">{done ? 'A rate is on file. Add a newer one any time under Settings → Exchange rates.' : 'Needed before the first document, so new entries do not start at 1.'}</p>
      <div className="mt-3 flex items-end gap-2">
        <Field label={`1 USD =`} htmlFor="ob-rate">
          <Input id="ob-rate" value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" placeholder="e.g. 3.6725" className="tnum w-40 text-right" />
        </Field>
        <span className="pb-2 text-sm font-semibold">{currency}</span>
        <Button
          variant="outline"
          disabled={!rate}
          onClick={async () => {
            const result = await saveExchangeRateAction({ currency, rate, effectiveDate: new Date().toISOString().slice(0, 10) });
            if (result.ok) {
              toast.success('Rate saved.');
              setRate('');
              router.refresh();
            } else toast.error(result.error);
          }}
        >
          Save rate
        </Button>
      </div>
    </div>
  );
}

function WarehouseStep({ existing, onAdd }: { existing: Props['warehouses']; onAdd: (v: { name: string; location?: string; port?: string }) => Promise<unknown> }) {
  const [name, setName] = React.useState('');
  const [location, setLocation] = React.useState('');
  return (
    <div className="space-y-4">
      {existing.length ? (
        <ul className="divide-y divide-line rounded-lg border border-line text-sm">
          {existing.map((w) => (
            <li key={w.name} className="flex justify-between px-3 py-2">
              <span className="font-medium">{w.name}</span>
              <span className="text-ink-muted">{w.location}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">No warehouse yet. Add the places where stock is kept — even one is enough to start.</p>
      )}
      <FieldGroup className="sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Warehouse name" htmlFor="ob-wh">
          <Input id="ob-wh" value={name} onChange={(e) => setName(e.target.value)} placeholder="Main warehouse" />
        </Field>
        <Field label="Location" htmlFor="ob-whl">
          <Input id="ob-whl" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="City or port" />
        </Field>
        <Button
          variant="outline"
          disabled={!name}
          onClick={async () => {
            await onAdd({ name, location });
            setName('');
            setLocation('');
          }}
        >
          <Plus /> Add
        </Button>
      </FieldGroup>
    </div>
  );
}

function BankStep({ existing, local, onAdd }: { existing: Props['accounts']; local: string; onAdd: (v: { name: string; accountType: 'CASH' | 'BANK'; currency: string; bankName?: string }) => Promise<unknown> }) {
  const [name, setName] = React.useState('');
  const [type, setType] = React.useState<'CASH' | 'BANK'>('BANK');
  const [currency, setCurrency] = React.useState(local);
  const [bank, setBank] = React.useState('');
  return (
    <div className="space-y-4">
      {existing.length ? (
        <ul className="divide-y divide-line rounded-lg border border-line text-sm">
          {existing.map((a) => (
            <li key={a.name} className="flex justify-between px-3 py-2">
              <span className="font-medium">{a.name}</span>
              <span className="text-ink-muted">
                {a.accountType === 'BANK' ? 'Bank' : 'Cash'} · {a.currency}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <FieldGroup className="sm:grid-cols-4 sm:items-end">
        <Field label="Name" htmlFor="ob-an">
          <Input id="ob-an" value={name} onChange={(e) => setName(e.target.value)} placeholder="Operating account" />
        </Field>
        <Field label="Kind" htmlFor="ob-at">
          <Select id="ob-at" value={type} onChange={(e) => setType(e.target.value as 'CASH' | 'BANK')}>
            <option value="BANK">Bank account</option>
            <option value="CASH">Cash in hand</option>
          </Select>
        </Field>
        <Field label="Currency" htmlFor="ob-ac">
          <Select id="ob-ac" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {[...new Set([local, 'USD', 'EUR', 'GBP', ...CURRENCIES.map((c) => c.code)])].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Bank" htmlFor="ob-ab">
          <Input id="ob-ab" value={bank} onChange={(e) => setBank(e.target.value)} placeholder="Optional" disabled={type === 'CASH'} />
        </Field>
      </FieldGroup>
      <Button
        variant="outline"
        disabled={!name}
        onClick={async () => {
          await onAdd({ name, accountType: type, currency, bankName: bank });
          setName('');
          setBank('');
        }}
      >
        <Plus /> Add account
      </Button>
      <p className="text-xs text-ink-subtle">Opening balances come in the last step, so the books start from the true figures.</p>
    </div>
  );
}

function TaxStep({ label, enabled, rates, onSave }: { label: string; enabled: boolean; rates: number; onSave: (v: { registered: boolean; registrationNumber?: string; label?: string; periodMonths?: number; rates?: Array<{ name: string; ratePct: string }> }) => Promise<unknown> }) {
  const [registered, setRegistered] = React.useState(enabled);
  const [reg, setReg] = React.useState('');
  const [name, setName] = React.useState(label);
  const rateName = 'Standard';
  const [rate, setRate] = React.useState('');
  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-forest-700" checked={registered} onChange={(e) => setRegistered(e.target.checked)} />
        This company is registered for {label || 'VAT'}
      </label>
      {registered ? (
        <>
          <FieldGroup className="sm:grid-cols-3">
            <Field label="Registration number" htmlFor="ob-tax-reg" required hint="Printed on every tax invoice.">
              <Input id="ob-tax-reg" value={reg} onChange={(e) => setReg(e.target.value)} />
            </Field>
            <Field label="What it is called" htmlFor="ob-tax-name">
              <Input id="ob-tax-name" value={name} maxLength={12} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Standard rate %" htmlFor="ob-tax-rate" hint={rates ? `${rates} rate(s) already set.` : 'Enter the rate your tax authority sets. None is assumed.'}>
              <Input id="ob-tax-rate" value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" className="tnum text-right" />
            </Field>
          </FieldGroup>
          <Button variant="outline" disabled={reg.trim().length < 5} onClick={() => onSave({ registered: true, registrationNumber: reg, label: name, rates: rate ? [{ name: rateName, ratePct: rate }] : [] })}>
            Save tax setup
          </Button>
        </>
      ) : (
        <p className="text-sm text-ink-muted">No tax will be calculated or shown anywhere. Turn it on later under Settings → Tax.</p>
      )}
    </div>
  );
}

function UsersStep({ roles, allowed }: { roles: Props['roles']; allowed: boolean }) {
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [roleId, setRoleId] = React.useState(roles[0]?.id ?? '');
  const [created, setCreated] = React.useState<Array<{ email: string; password: string }>>([]);
  if (!allowed) return <p className="text-sm text-ink-muted">Only an administrator can add people.</p>;
  return (
    <div className="space-y-4">
      <FieldGroup className="sm:grid-cols-3">
        <Field label="Name" htmlFor="ob-un">
          <Input id="ob-un" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email" htmlFor="ob-ue">
          <Input id="ob-ue" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Role" htmlFor="ob-ur" hint={roles.find((r) => r.id === roleId)?.description ?? undefined}>
          <Select id="ob-ur" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
      </FieldGroup>
      <Button
        variant="outline"
        disabled={!name || !email || !roleId}
        onClick={async () => {
          const result = await inviteUserAction({ name, email, roleId });
          if (result.ok) {
            setCreated((c) => [...c, result.data]);
            setName('');
            setEmail('');
          } else toast.error(result.error);
        }}
      >
        <Plus /> Add person
      </Button>
      {created.length ? (
        <Callout tone="warning" title="Give each person their temporary password — it is shown once">
          <ul className="mt-1 space-y-1 font-mono text-xs">
            {created.map((c) => (
              <li key={c.email}>
                {c.email} — <strong>{c.password}</strong>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs">They must choose their own password at first sign-in.</p>
        </Callout>
      ) : null}
    </div>
  );
}

function DataStep({ imports }: { imports: Props['options']['imports'] }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-muted">Optional. Download a template, fill it in Excel, and upload it. You see exactly what would happen before anything is saved. Order matters: items and warehouses first, then customers, suppliers, opening stock and opening balances.</p>
      <div className="grid gap-3 lg:grid-cols-2">
        {imports.map((i) => (
          <ImportCard key={i.kind} {...i} />
        ))}
      </div>
    </div>
  );
}

function ImportCard({ kind, label, description }: { kind: string; label: string; description: string }) {
  const router = useRouter();
  const input = React.useRef<HTMLInputElement>(null);
  const [preview, setPreview] = React.useState<ImportPreview | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function send(commit: boolean) {
    const file = input.current?.files?.[0];
    if (!file) return toast.error('Choose a file first.');
    const body = new FormData();
    body.set('file', file);
    setBusy(true);
    try {
      if (!commit) {
        const result = await previewImportAction(kind, body);
        if (result.ok) setPreview(result.data);
        else {
          setPreview(null);
          toast.error(result.error);
        }
      } else {
        const result = await commitImportAction(kind, body);
        if (result.ok) {
          toast.success(result.message ?? 'Imported.');
          setPreview(null);
          if (input.current) input.current.value = '';
          router.refresh();
        } else toast.error(result.error);
      }
    } finally {
      setBusy(false);
    }
  }

  const problems = preview ? preview.failed.length : 0;
  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">{label}</p>
          <p className="text-xs text-ink-subtle">{description}</p>
        </div>
        <a href={`/api/import-template/${kind}`} className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-forest-700 hover:underline">
          <Download className="size-3.5" /> Template
        </a>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input ref={input} type="file" accept=".csv,.xlsx,.txt" className="max-w-full text-xs" onChange={() => setPreview(null)} aria-label={`${label} file`} />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => send(false)}>
          Check file
        </Button>
        <Button size="sm" disabled={busy || !preview || problems > 0 || preview.created === 0} onClick={() => send(true)}>
          Import
        </Button>
      </div>
      {preview ? (
        <div className="mt-3 space-y-1 text-xs" role="status">
          <p className="font-medium text-ink">
            {preview.created} would be imported{preview.skipped.length ? `, ${preview.skipped.length} skipped` : ''}
            {problems ? `, ${problems} with problems` : ''}.
          </p>
          {preview.unknownColumns.length ? <p className="text-ink-subtle">Ignored columns: {preview.unknownColumns.join(', ')}</p> : null}
          {[...preview.failed.map((f) => ({ ...f, bad: true })), ...preview.skipped.map((f) => ({ ...f, bad: false }))].slice(0, 8).map((f) => (
            <p key={`${f.line}-${f.reason}`} className={f.bad ? 'text-red-700' : 'text-ink-muted'}>
              Row {f.line}: {f.reason}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
