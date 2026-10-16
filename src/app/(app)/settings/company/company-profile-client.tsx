'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Field, FieldGroup } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Callout } from '@/components/ui/feedback';
import { CurrencyPicker } from '@/components/shared/currency-picker';
import {
  removeCompanyLogoAction,
  saveCompanyConfigAction,
  saveCompanyProfileAction,
  uploadCompanyLogoAction,
} from '@/server/actions/company-actions';

type Profile = {
  name: string;
  legalName: string;
  tradingName: string;
  tagline: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  companyRegistration: string;
  dateFormat: string;
  numberLocale: string;
  timezone: string;
  country: string;
  localCurrency: string;
  hasLogo: boolean;
  logoVersion: number;
};

type Config = {
  industryTemplate: string;
  businessType: string;
  transactionCurrencies: string[];
  salesCurrencies: string[];
  defaultSalesCurrency: string;
  features: Record<string, boolean>;
  terminology: Record<string, string>;
  fxCostPolicy: string;
};

type Options = {
  templates: Array<{ key: string; label: string; description: string }>;
  businessTypes: Array<{ value: string; label: string }>;
  features: Array<{ key: string; label: string; description: string; allowedByPlan: boolean }>;
  planLabel: string;
  terms: Array<{ key: string; fallback: string }>;
  locales: string[];
};

const TERM_LABELS: Record<string, string> = {
  item: 'An item (singular)',
  items: 'Items (plural)',
  product: 'What you trade, in a sentence',
  customer: 'Customer',
  customers: 'Customers',
  supplier: 'Supplier',
  suppliers: 'Suppliers',
  shipment: 'Shipment',
  shipments: 'Shipments',
  warehouse: 'Warehouse',
  warehouses: 'Warehouses',
  unit: 'Unit stock is counted in',
  purchaseOrder: 'Purchase order',
  orderRef: 'Order reference (short)',
  orderReference: 'Order reference (long)',
};

const FX_POLICIES = [
  { value: 'RECOST_ALL', label: 'Use the actual rate — it updates purchase cost, landed cost, stock value, cost of sales and profit' },
  { value: 'NONE', label: 'Keep the estimated rate — the actual-rate box is not offered' },
];

export function CompanyProfileClient({ profile, config, options }: { profile: Profile; config: Config; options: Options }) {
  const router = useRouter();
  const [savingProfile, setSavingProfile] = React.useState(false);
  const [savingConfig, setSavingConfig] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [state, setState] = React.useState<Config>(config);
  const set = <K extends keyof Config>(key: K, value: Config[K]) => setState((s) => ({ ...s, [key]: value }));

  async function saveProfile(formData: FormData) {
    setSavingProfile(true);
    try {
      const result = await saveCompanyProfileAction(formData);
      if (result.ok) {
        toast.success('Company profile saved.');
        router.refresh();
      } else toast.error(result.error);
    } finally {
      setSavingProfile(false);
    }
  }

  async function saveConfig() {
    setSavingConfig(true);
    try {
      const result = await saveCompanyConfigAction({
        industryTemplate: state.industryTemplate,
        businessType: state.businessType,
        transactionCurrencies: state.transactionCurrencies,
        salesCurrencies: state.salesCurrencies,
        defaultSalesCurrency: state.defaultSalesCurrency || null,
        features: state.features,
        terminology: state.terminology,
        fxCostPolicy: state.fxCostPolicy as 'RECOST_ALL' | 'NONE',
      });
      if (result.ok) {
        toast.success('Configuration saved.');
        router.refresh();
      } else toast.error(result.error);
    } finally {
      setSavingConfig(false);
    }
  }

  async function uploadLogo(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const body = new FormData();
      body.set('logo', file);
      const result = await uploadCompanyLogoAction(body);
      if (result.ok) {
        toast.success('Logo updated.');
        router.refresh();
      } else toast.error(result.error);
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  }

  const salesChoices = [...new Set([profile.localCurrency, ...state.transactionCurrencies])];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Identity on documents</CardTitle>
          <CardDescription>
            Printed on this company’s invoices, statements, shipment reports and ledgers — never another company’s, and never the product’s name.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={saveProfile} className="space-y-4">
            <FieldGroup className="sm:grid-cols-2">
              <Field label="Company name" required htmlFor="name" hint="Shown in the top bar.">
                <Input id="name" name="name" defaultValue={profile.name} maxLength={160} required />
              </Field>
              <Field label="Legal name" htmlFor="legalName" hint="As registered; printed on tax invoices.">
                <Input id="legalName" name="legalName" defaultValue={profile.legalName} maxLength={200} />
              </Field>
              <Field label="Trading name" htmlFor="tradingName" hint="If customers know you by another name.">
                <Input id="tradingName" name="tradingName" defaultValue={profile.tradingName} maxLength={160} />
              </Field>
              <Field label="Tagline" htmlFor="tagline" hint="One short line under the name.">
                <Input id="tagline" name="tagline" defaultValue={profile.tagline} maxLength={80} />
              </Field>
              <Field label="Address" htmlFor="address" className="sm:col-span-2">
                <Input id="address" name="address" defaultValue={profile.address} maxLength={400} />
              </Field>
              <Field label="Phone" htmlFor="phone">
                <Input id="phone" name="phone" defaultValue={profile.phone} maxLength={40} />
              </Field>
              <Field label="Email" htmlFor="email">
                <Input id="email" name="email" type="email" defaultValue={profile.email} maxLength={200} />
              </Field>
              <Field label="Website" htmlFor="website">
                <Input id="website" name="website" defaultValue={profile.website} maxLength={200} />
              </Field>
              <Field label="Company registration no." htmlFor="companyRegistration">
                <Input id="companyRegistration" name="companyRegistration" defaultValue={profile.companyRegistration} maxLength={60} />
              </Field>
              <Field label="Date format" htmlFor="dateFormat">
                <Select id="dateFormat" name="dateFormat" defaultValue={profile.dateFormat}>
                  <option value="DD MMM YYYY">31 Mar 2026</option>
                  <option value="DD/MM/YYYY">31/03/2026</option>
                  <option value="MM/DD/YYYY">03/31/2026</option>
                  <option value="YYYY-MM-DD">2026-03-31</option>
                </Select>
              </Field>
              <Field label="Number style" htmlFor="numberLocale" hint="Decides the thousands and decimal marks.">
                <Select id="numberLocale" name="numberLocale" defaultValue={profile.numberLocale}>
                  {[...new Set([profile.numberLocale, ...options.locales])].map((l) => (
                    <option key={l} value={l}>
                      {l} — {new Intl.NumberFormat(l).format(1234567.89)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Time zone" htmlFor="timezone">
                <Input id="timezone" name="timezone" defaultValue={profile.timezone} maxLength={60} />
              </Field>
              <Field label="Country" hint="Fixed once the company is created.">
                <Input value={profile.country} disabled readOnly />
              </Field>
            </FieldGroup>
            <Button type="submit" disabled={savingProfile}>
              {savingProfile ? 'Saving…' : 'Save profile'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Logo</CardTitle>
          <CardDescription>PNG, JPEG or WebP, under 512 KB. It appears on printed and shared documents.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-4">
          <div className="grid h-20 w-48 place-items-center rounded-lg border border-line bg-surface-muted">
            {profile.hasLogo ? (
              // eslint-disable-next-line @next/next/no-img-element -- served by an authenticated route, not a static asset
              <img src={`/api/company-logo?v=${profile.logoVersion}`} alt={`${profile.name} logo`} className="max-h-16 max-w-44 object-contain" />
            ) : (
              <span className="text-xs text-ink-subtle">No logo yet</span>
            )}
          </div>
          <label className="inline-flex">
            <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={uploadLogo} disabled={uploading} data-testid="logo-input" />
            <span className="inline-flex h-10 cursor-pointer items-center rounded-lg border border-line bg-surface px-4 text-sm font-medium hover:bg-forest-50">
              {uploading ? 'Uploading…' : profile.hasLogo ? 'Replace logo' : 'Upload logo'}
            </span>
          </label>
          {profile.hasLogo ? (
            <Button
              variant="outline"
              onClick={async () => {
                const result = await removeCompanyLogoAction();
                if (result.ok) {
                  toast.success('Logo removed.');
                  router.refresh();
                } else toast.error(result.error);
              }}
            >
              Remove
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Industry and business</CardTitle>
          <CardDescription>A preset only chooses which modules start on and which item fields are offered. Everything stays changeable.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup className="sm:grid-cols-2">
            <Field label="Industry preset" htmlFor="industry">
              <Select id="industry" value={state.industryTemplate} onChange={(e) => set('industryTemplate', e.target.value)}>
                {options.templates.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Business type" htmlFor="businessType">
              <Select id="businessType" value={state.businessType} onChange={(e) => set('businessType', e.target.value)}>
                {options.businessTypes.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </Select>
            </Field>
          </FieldGroup>
          <p className="mt-2 text-xs text-ink-subtle">{options.templates.find((t) => t.key === state.industryTemplate)?.description}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Currencies</CardTitle>
          <CardDescription>
            The books are kept in <strong>{profile.localCurrency}</strong> and that never changes after the first posting. Choose any others this company pays, receives
            or invoices in.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field label="Currencies used on payments, expenses and purchases" hint="Leave empty to keep the standard list.">
            <CurrencyPicker value={state.transactionCurrencies} onChange={(v) => set('transactionCurrencies', v)} fixed={profile.localCurrency} aria-label="Transaction currencies" />
          </Field>
          <Field label="Currencies invoiced to customers" hint="Pick only the ones you sell in. If there is just one, invoices will not ask for an exchange rate.">
            <CurrencyPicker value={state.salesCurrencies} onChange={(v) => set('salesCurrencies', v)} aria-label="Sales currencies" />
          </Field>
          <Field label="Default sales currency" htmlFor="defaultSales">
            <Select id="defaultSales" value={state.defaultSalesCurrency} onChange={(e) => set('defaultSalesCurrency', e.target.value)}>
              <option value="">The company’s own currency ({profile.localCurrency})</option>
              {(state.salesCurrencies.length ? state.salesCurrencies : salesChoices).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="When an actual exchange rate replaces the estimate" htmlFor="fxPolicy">
            <Select id="fxPolicy" value={state.fxCostPolicy} onChange={(e) => set('fxCostPolicy', e.target.value)}>
              {FX_POLICIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Modules</CardTitle>
          <CardDescription>
            Switch off what this company does not use and it disappears from the menu, the dashboard and the search — for everyone, owner included. Your plan is{' '}
            <strong>{options.planLabel}</strong>. Nothing is deleted; switching a module back on restores it as it was.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2">
          {options.features.map((f) => (
            <label key={f.key} className="flex items-start gap-3 rounded-lg border border-line p-3 has-[:disabled]:opacity-60">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-forest-700"
                checked={Boolean(state.features[f.key]) && f.allowedByPlan}
                disabled={!f.allowedByPlan}
                onChange={(e) => set('features', { ...state.features, [f.key]: e.target.checked })}
              />
              <span>
                <span className="block text-sm font-medium text-ink">{f.label}</span>
                <span className="block text-xs text-ink-subtle">{f.allowedByPlan ? f.description : 'Not included in your plan.'}</span>
              </span>
            </label>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Wording</CardTitle>
          <CardDescription>Say “Buyer” instead of “Customer”, “Consignment” instead of “Shipment”. Only the label changes — the accounting underneath does not.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup className="sm:grid-cols-3">
            {options.terms.map((t) => (
              <Field key={t.key} label={TERM_LABELS[t.key] ?? t.key} htmlFor={`term-${t.key}`}>
                <Input
                  id={`term-${t.key}`}
                  value={state.terminology[t.key] ?? ''}
                  placeholder={t.fallback}
                  maxLength={40}
                  onChange={(e) => set('terminology', { ...state.terminology, [t.key]: e.target.value })}
                />
              </Field>
            ))}
          </FieldGroup>
        </CardContent>
      </Card>

      <Callout tone="info" title="Saved together">
        The industry, currencies, modules, accounting policy and wording above are saved with one button.
      </Callout>
      <div className="flex gap-2">
        <Button onClick={saveConfig} disabled={savingConfig}>
          {savingConfig ? 'Saving…' : 'Save configuration'}
        </Button>
      </div>
    </div>
  );
}
