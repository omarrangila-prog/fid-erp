'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Field, FieldGroup } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Callout } from '@/components/ui/feedback';
import { createTenantAction, resetTenantOwnerAction, setTenantPlanAction, setTenantStatusAction, tenantHealthAction } from '@/server/actions/platform-actions';

type Tenant = {
  organizationId: string;
  name: string;
  plan: string;
  status: string;
  createdAt: string;
  companies: Array<{ id: string; code: string; name: string; country: string; localCurrency: string; template: string }>;
  users: number;
  activeUsers30d: number;
  lastLoginAt: string | null;
  postedThisMonth: number;
  storageMb: number;
};

export function PlatformConsole({ tenants, countries, templates, plans }: { tenants: Tenant[]; countries: string[]; templates: Array<{ key: string; label: string }>; plans: Array<{ key: string; label: string }> }) {
  const router = useRouter();
  const [secret, setSecret] = React.useState<{ title: string; email: string; password: string } | null>(null);
  const [health, setHealth] = React.useState<Record<string, Array<{ code: string; passed: number; total: number }>>>({});
  const [form, setForm] = React.useState({ organizationName: '', companyName: '', country: 'United Arab Emirates', industryTemplate: 'GENERAL_TRADING', plan: 'GROWTH', ownerName: '', ownerEmail: '' });
  const [busy, setBusy] = React.useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await createTenantAction(form);
      if (r.ok) {
        setSecret({ title: `${form.companyName} created (${r.data.companyCode})`, email: r.data.email, password: r.data.password });
        setForm((f) => ({ ...f, organizationName: '', companyName: '', ownerName: '', ownerEmail: '' }));
        router.refresh();
      } else toast.error(r.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {secret ? (
        <Callout tone="warning" title={secret.title}>
          Give the owner this temporary password now — it is shown once and must be changed at first sign-in.
          <p className="mt-2 font-mono text-sm">
            {secret.email} — <strong data-testid="temp-password">{secret.password}</strong>
          </p>
        </Callout>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>New customer</CardTitle>
          <CardDescription>Creates the organization, its first company with a chart of accounts, and the owner’s sign-in. The owner finishes setup in the wizard.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="space-y-4">
            <FieldGroup className="sm:grid-cols-3">
              <Field label="Customer (organization)" htmlFor="p-org" required>
                <Input id="p-org" value={form.organizationName} onChange={set('organizationName')} required />
              </Field>
              <Field label="First company" htmlFor="p-co" required>
                <Input id="p-co" value={form.companyName} onChange={set('companyName')} required />
              </Field>
              <Field label="Country" htmlFor="p-country">
                <Select id="p-country" value={form.country} onChange={set('country')}>
                  {countries.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Industry preset" htmlFor="p-ind">
                <Select id="p-ind" value={form.industryTemplate} onChange={set('industryTemplate')}>
                  {templates.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Plan" htmlFor="p-plan">
                <Select id="p-plan" value={form.plan} onChange={set('plan')}>
                  {plans.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <span />
              <Field label="Owner name" htmlFor="p-on" required>
                <Input id="p-on" value={form.ownerName} onChange={set('ownerName')} required />
              </Field>
              <Field label="Owner email" htmlFor="p-oe" required>
                <Input id="p-oe" type="email" value={form.ownerEmail} onChange={set('ownerEmail')} required />
              </Field>
            </FieldGroup>
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create customer'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-3" data-testid="tenant-list">
        {tenants.map((t) => (
          <Card key={t.organizationId}>
            <CardContent className="space-y-3 pt-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-base font-semibold text-ink">{t.name}</p>
                  <p className="text-xs text-ink-subtle">
                    {t.companies.map((c) => `${c.code} · ${c.country} · ${c.localCurrency}`).join('  |  ')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={t.status === 'ACTIVE' ? 'success' : 'neutral'}>{t.status === 'ACTIVE' ? 'Active' : 'Switched off'}</Badge>
                  <Select aria-label={`Plan for ${t.name}`} value={t.plan} className="h-8 w-32 text-xs" onChange={async (e) => {
                    const r = await setTenantPlanAction(t.organizationId, e.target.value);
                    if (r.ok) { toast.success('Plan changed.'); router.refresh(); } else toast.error(r.error);
                  }}>
                    {plans.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
                {[
                  ['Users', `${t.users} (${t.activeUsers30d} active in 30 days)`],
                  ['Entries this month', String(t.postedThisMonth)],
                  ['Storage', `${t.storageMb} MB`],
                  ['Last sign-in', t.lastLoginAt ? new Date(t.lastLoginAt).toLocaleDateString('en-GB') : 'never'],
                  ['Created', new Date(t.createdAt).toLocaleDateString('en-GB')],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-ink-subtle">{k}</dt>
                    <dd className="font-medium text-ink">{v}</dd>
                  </div>
                ))}
              </dl>
              {health[t.organizationId] ? (
                <p className="text-xs text-ink-muted">
                  Health: {health[t.organizationId].map((h) => `${h.code} ${h.passed}/${h.total} checks pass`).join(' · ')}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={async () => {
                  const r = await tenantHealthAction(t.organizationId);
                  if (r.ok) setHealth((h) => ({ ...h, [t.organizationId]: r.data })); else toast.error(r.error);
                }}>
                  Run health check
                </Button>
                <Button size="sm" variant="outline" onClick={async () => {
                  const r = await resetTenantOwnerAction(t.organizationId);
                  if (r.ok) setSecret({ title: `Owner of ${t.name} re-keyed`, ...r.data }); else toast.error(r.error);
                }}>
                  Reset owner password
                </Button>
                <Button size="sm" variant={t.status === 'ACTIVE' ? 'outline' : 'primary'} onClick={async () => {
                  const r = await setTenantStatusAction(t.organizationId, t.status !== 'ACTIVE');
                  if (r.ok) { toast.success(t.status === 'ACTIVE' ? 'Switched off; everyone signed out.' : 'Switched on.'); router.refresh(); } else toast.error(r.error);
                }}>
                  {t.status === 'ACTIVE' ? 'Switch off' : 'Switch on'}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
