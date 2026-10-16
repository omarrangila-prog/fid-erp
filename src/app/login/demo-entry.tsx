'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { demoLoginAction } from '@/server/actions/session-actions';

/** One click into the fictional demonstration company — shown only when the server is in demo mode. */
export function DemoEntry() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  return (
    <div className="rounded-xl border border-gold-300 bg-gold-50 p-4 text-center" data-testid="demo-entry">
      <p className="text-sm font-semibold text-ink">Just looking around?</p>
      <p className="mt-1 text-xs text-ink-muted">Explore a fictional company with real, balanced books. No sign-up.</p>
      <Button
        className="mt-3"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const result = await demoLoginAction();
          if (result.ok) router.push(result.data.redirectTo);
          else {
            toast.error(result.error);
            setBusy(false);
          }
        }}
      >
        {busy ? 'Opening…' : 'Explore the demo'}
      </Button>
    </div>
  );
}
