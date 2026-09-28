'use client';

import * as React from 'react';
import { Download, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { shareFileName, type ShareSnapshot } from '@/lib/share/model';

/** The recipient's own copy: the same PDF the sender could have attached, or the browser's print. */
export function SharedPdfButton({ snapshot }: { snapshot: ShareSnapshot }) {
  const [busy, setBusy] = React.useState(false);

  async function download() {
    setBusy(true);
    try {
      const { buildSharePdf } = await import('@/lib/share/pdf');
      const blob = await buildSharePdf(snapshot);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = shareFileName(snapshot);
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={download} loading={busy} data-testid="shared-download-pdf">
        <Download /> Download PDF
      </Button>
      <Button size="sm" variant="outline" onClick={() => window.print()}>
        <Printer /> Print
      </Button>
    </>
  );
}
