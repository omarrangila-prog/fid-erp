'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Ban } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { revokeShareLinkAction } from '@/server/actions/share-actions';

/** Withdraws a shared link: from now on it opens to "This link was withdrawn". */
export function RevokeLinkButton({ shareId }: { shareId: string }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      loading={pending}
      data-testid="revoke-share-link"
      onClick={() => {
        if (!window.confirm('Revoke this link? Anyone who opens it afterwards will see that it was withdrawn.')) return;
        startTransition(async () => {
          const result = await revokeShareLinkAction(shareId);
          if (result.ok) {
            toast.success(result.message ?? 'Link revoked.');
            router.refresh();
          } else {
            toast.error(result.error);
          }
        });
      }}
    >
      <Ban /> Revoke
    </Button>
  );
}
