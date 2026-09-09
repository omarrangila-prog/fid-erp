'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCcw, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/**
 * The error boundary for every authenticated page.
 *
 * Next.js strips error messages in production, so this deliberately does not
 * pretend to explain the cause. It gives the user a way forward and surfaces
 * the digest, which is what ties the screen to the server log entry.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    console.error('[page-error]', error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center py-16 text-center">
      <div className="grid size-12 place-items-center rounded-xl border border-red-200 bg-red-50 text-red-600">
        <AlertTriangle className="size-6" />
      </div>

      <h1 className="mt-5 text-xl font-semibold tracking-tight text-ink">Something went wrong on this page</h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
        Nothing was saved. You can try again, and if it keeps happening, send the reference below to whoever supports
        this system.
      </p>

      {error.digest ? (
        <Card className="mt-6 w-full max-w-sm">
          <CardContent className="pt-5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">Reference</p>
            <code className="mt-1 block text-sm text-ink">{error.digest}</code>
          </CardContent>
        </Card>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Button onClick={reset}>
          <RotateCcw />
          Try again
        </Button>
        <Button variant="outline" asChild>
          <Link href="/dashboard">
            <ArrowLeft />
            Back to the dashboard
          </Link>
        </Button>
      </div>
    </div>
  );
}
