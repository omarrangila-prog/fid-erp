'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { addMissingStandardRolesAction } from '@/server/actions/admin-actions';

export function AddStandardRoles({ missing }: { missing: string[] }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  return (
    <Button
      size="sm"
      loading={pending}
      data-testid="add-standard-roles"
      onClick={() =>
        startTransition(async () => {
          const result = await addMissingStandardRolesAction();
          if (result.ok) {
            toast.success(`Added: ${result.data.added.join(', ')}.`);
            router.refresh();
          } else {
            toast.error(result.error);
          }
        })
      }
    >
      Add {missing.join(', ')}
    </Button>
  );
}
