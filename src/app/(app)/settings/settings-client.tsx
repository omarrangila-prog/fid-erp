'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { saveSettingAction } from '@/server/actions/admin-actions';

export type SettingSpec = {
  key: string;
  label: string;
  description: string;
  value: string;
  kind: 'boolean' | 'text' | 'number' | 'csv';
  scope: string;
};

export function SettingsClient({ groups }: { groups: Array<{ title: string; description: string; settings: SettingSpec[] }> }) {
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <Card key={group.title}>
          <CardHeader>
            <CardTitle>{group.title}</CardTitle>
            <CardDescription>{group.description}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {group.settings.map((setting) => (
              <SettingRow key={setting.key} setting={setting} />
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function SettingRow({ setting }: { setting: SettingSpec }) {
  const router = useRouter();
  const [value, setValue] = React.useState(setting.value);
  const [pending, startTransition] = React.useTransition();

  const dirty = value !== setting.value;

  function save() {
    startTransition(async () => {
      const result = await saveSettingAction(setting.key, value);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`${setting.label} saved.`);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3 border-b border-line pb-5 last:border-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 sm:max-w-md">
        <p className="text-sm font-medium text-ink">{setting.label}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{setting.description}</p>
        <p className="mt-1 text-[11px] text-ink-subtle">
          <code className="rounded bg-forest-50 px-1 py-0.5">{setting.key}</code> · currently set at {setting.scope} level
        </p>
      </div>

      <div className="flex shrink-0 items-end gap-2">
        <Field label="" className="w-48">
          {setting.kind === 'boolean' ? (
            <Select value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="false">Disabled</option>
              <option value="true">Enabled</option>
            </Select>
          ) : (
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode={setting.kind === 'number' ? 'numeric' : undefined}
              className={setting.kind === 'number' ? 'tnum text-right' : undefined}
            />
          )}
        </Field>
        <Button onClick={save} disabled={!dirty} loading={pending} variant={dirty ? 'primary' : 'outline'}>
          Save
        </Button>
      </div>
    </div>
  );
}
