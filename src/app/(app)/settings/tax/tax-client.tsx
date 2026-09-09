'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, Power, PowerOff, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input, Select } from '@/components/ui/input';
import { Field, FieldGroup } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Callout } from '@/components/ui/feedback';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import {
  enableTaxAction,
  disableTaxAction,
  saveTaxCodeAction,
  archiveTaxCodeAction,
} from '@/server/actions/compliance-actions';

export type TaxCodeRow = {
  id: string;
  code: string;
  name: string;
  ratePct: string;
  treatment: string;
  appliesTo: string;
  isDefault: boolean;
  isSystem: boolean;
};

const TREATMENTS = [
  { value: 'STANDARD', label: 'Standard rated — tax is charged' },
  { value: 'ZERO_RATED', label: 'Zero rated — an export, taxed at 0%' },
  { value: 'EXEMPT', label: 'Exempt — outside the tax, no recovery' },
  { value: 'OUT_OF_SCOPE', label: 'Out of scope' },
  { value: 'REVERSE_CHARGE', label: 'Reverse charge — import' },
];

const APPLIES = [
  { value: 'BOTH', label: 'Sales and purchases' },
  { value: 'SALES', label: 'Sales only' },
  { value: 'PURCHASE', label: 'Purchases only' },
];

export function TaxSettingsClient({
  enabled,
  label,
  registrationNumber,
  periodMonths,
  suggestedLabel,
  suggestedRate,
  country,
  codes,
}: {
  enabled: boolean;
  label: string;
  registrationNumber: string | null;
  periodMonths: number;
  suggestedLabel: string;
  suggestedRate: number;
  country: string;
  codes: TaxCodeRow[];
}) {
  const router = useRouter();
  const [saving, setSaving] = React.useState(false);
  const [editing, setEditing] = React.useState<TaxCodeRow | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [confirmDisable, setConfirmDisable] = React.useState(false);
  const [removing, setRemoving] = React.useState<TaxCodeRow | null>(null);

  async function saveRegistration(formData: FormData) {
    setSaving(true);
    try {
      const result = await enableTaxAction(formData);
      if (result?.ok) {
        toast.success(result.message);
        router.refresh();
      } else {
        toast.error(result?.error ?? 'That could not be saved.');
      }
    } finally {
      setSaving(false);
    }
  }

  const editable = editing ?? (creating ? blankCode() : null);

  return (
    <div className="space-y-6">
      {!enabled ? (
        <Callout tone="info" title="This company is not registered for tax">
          Nothing charges tax and no tax appears anywhere in the application. Turn it on only once the company actually
          holds a registration certificate — a business below the threshold should not be collecting tax it has no
          authority to collect.
        </Callout>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Registration</CardTitle>
          <CardDescription>
            {country === 'AE'
              ? 'UAE VAT is normally 5%, filed quarterly with the Federal Tax Authority.'
              : country === 'MA'
                ? 'Moroccan TVA is normally 20%, filed monthly.'
                : 'Enter the registration details exactly as they appear on the certificate.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={saveRegistration} className="space-y-4">
            <FieldGroup className="sm:grid-cols-3">
              <Field
                label="Registration number"
                required
                hint="Printed on every tax invoice you issue."
                htmlFor="registrationNumber"
              >
                <Input
                  id="registrationNumber"
                  name="registrationNumber"
                  defaultValue={registrationNumber ?? ''}
                  maxLength={60}
                  required
                />
              </Field>
              <Field label="What it is called" required htmlFor="label" hint="VAT in the UAE, TVA in Morocco.">
                <Input id="label" name="label" defaultValue={label || suggestedLabel} maxLength={12} required />
              </Field>
              <Field label="Filing period" required htmlFor="periodMonths">
                <Select id="periodMonths" name="periodMonths" defaultValue={String(periodMonths)}>
                  <option value="1">Monthly</option>
                  <option value="3">Quarterly</option>
                  <option value="12">Annually</option>
                </Select>
              </Field>
            </FieldGroup>

            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={saving}>
                <Power />
                {enabled ? 'Save registration' : 'Turn tax on'}
              </Button>
              {enabled ? (
                <Button type="button" variant="outline" onClick={() => setConfirmDisable(true)}>
                  <PowerOff />
                  Turn tax off
                </Button>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Tax codes</CardTitle>
            <CardDescription>
              A zero-rated export and an exempt supply both charge nothing, but they appear on different lines of the
              return — which is why they are separate codes rather than one &ldquo;0%&rdquo;.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => { setCreating(true); setEditing(null); }}>
            <Plus />
            Add a code
          </Button>
        </CardHeader>
        <CardContent className="px-0 sm:px-0">
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Code</TH>
                  <TH>Name</TH>
                  <TH numeric>Rate</TH>
                  <TH>Treatment</TH>
                  <TH>Used on</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {codes.map((code) => (
                  <TR key={code.id}>
                    <TD>
                      <span className="font-mono font-medium">{code.code}</span>
                      {code.isDefault ? (
                        <Badge tone="info" className="ml-2">
                          default
                        </Badge>
                      ) : null}
                    </TD>
                    <TD>{code.name}</TD>
                    <TD numeric>{Number(code.ratePct).toFixed(2)}%</TD>
                    <TD>
                      <span className="text-xs">{code.treatment.replace(/_/g, ' ').toLowerCase()}</span>
                    </TD>
                    <TD>
                      <span className="text-xs">{code.appliesTo.toLowerCase()}</span>
                    </TD>
                    <TD>
                      <span className="flex items-center justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => { setEditing(code); setCreating(false); }}>
                          Edit
                        </Button>
                        {!code.isSystem ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Deactivate ${code.code}`}
                            onClick={() => setRemoving(code)}
                          >
                            <Trash2 className="text-red-500" />
                          </Button>
                        ) : null}
                      </span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {editable ? (
        <TaxCodeEditor
          key={editable.id || 'new'}
          initial={editable}
          suggestedRate={suggestedRate}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSaved={() => {
            setEditing(null);
            setCreating(false);
            router.refresh();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title="Turn tax off?"
        description="New documents stop carrying tax. Everything already posted keeps its tax lines — those were correct when issued, and a filed return depends on them."
        confirmLabel="Turn tax off"
        variant="danger"
        onConfirm={async () => {
          const result = await disableTaxAction();
          if (result.ok) {
            toast.success('Tax switched off for new documents.');
            router.refresh();
          } else {
            throw new Error(result.error);
          }
        }}
      />

      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Deactivate ${removing?.code ?? ''}?`}
        description="It stops appearing on new documents. Documents that already use it keep it, so history and past returns stay intact."
        confirmLabel="Deactivate"
        variant="danger"
        onConfirm={async () => {
          if (!removing) return;
          const result = await archiveTaxCodeAction(removing.id);
          if (result.ok) {
            toast.success('Tax code deactivated.');
            router.refresh();
          } else {
            throw new Error(result.error);
          }
        }}
      />
    </div>
  );
}

function blankCode(): TaxCodeRow {
  return {
    id: '',
    code: '',
    name: '',
    ratePct: '0',
    treatment: 'STANDARD',
    appliesTo: 'BOTH',
    isDefault: false,
    isSystem: false,
  };
}

function TaxCodeEditor({
  initial,
  suggestedRate,
  onClose,
  onSaved,
}: {
  initial: TaxCodeRow;
  suggestedRate: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = React.useState(initial.code);
  const [name, setName] = React.useState(initial.name);
  const [ratePct, setRatePct] = React.useState(initial.ratePct);
  const [treatment, setTreatment] = React.useState(initial.treatment);
  const [appliesTo, setAppliesTo] = React.useState(initial.appliesTo);
  const [isDefault, setIsDefault] = React.useState(initial.isDefault);
  const [saving, setSaving] = React.useState(false);

  const standard = treatment === 'STANDARD';

  async function save() {
    setSaving(true);
    try {
      const result = await saveTaxCodeAction(
        JSON.stringify({
          id: initial.id,
          code,
          name,
          ratePct: standard ? ratePct : '0',
          treatment,
          appliesTo,
          isDefault,
        }),
      );
      if (result?.ok) {
        toast.success(result.message);
        onSaved();
      } else {
        toast.error(result?.error ?? 'That could not be saved.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{initial.id ? `Edit ${initial.code}` : 'New tax code'}</CardTitle>
        <CardDescription>
          Only a standard-rated code carries a rate. Everything else charges nothing by definition.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <FieldGroup className="sm:grid-cols-2">
          <Field label="Code" required hint="Short, e.g. STD or ZERO.">
            <Input value={code} onChange={(event) => setCode(event.target.value)} maxLength={12} autoFocus />
          </Field>
          <Field label="Name" required>
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
          </Field>
        </FieldGroup>

        <FieldGroup className="sm:grid-cols-3">
          <Field label="Treatment" required>
            <Select value={treatment} onChange={(event) => setTreatment(event.target.value)}>
              {TREATMENTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Rate %"
            required={standard}
            hint={standard ? `The statutory rate here is ${suggestedRate}%.` : 'Not applicable to this treatment.'}
          >
            <Input
              value={standard ? ratePct : '0'}
              onChange={(event) => setRatePct(event.target.value)}
              inputMode="decimal"
              disabled={!standard}
            />
          </Field>
          <Field label="Used on" required>
            <Select value={appliesTo} onChange={(event) => setAppliesTo(event.target.value)}>
              {APPLIES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        </FieldGroup>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(event) => setIsDefault(event.target.checked)}
            className="size-4 accent-forest-700"
          />
          Choose this code automatically on new document lines
        </label>

        <div className="flex flex-wrap gap-2">
          <Button onClick={save} loading={saving}>
            Save code
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
