import Link from 'next/link';
import { FileQuestion, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function AppNotFound() {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center py-16 text-center">
      <div className="grid size-12 place-items-center rounded-xl border border-line bg-navy-50 text-navy-500">
        <FileQuestion className="size-6" />
      </div>

      <h1 className="mt-5 text-xl font-semibold tracking-tight text-ink">That record does not exist</h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
        It may have been deleted, or it belongs to a company you do not have access to. Records are never shared
        between FID Trading L.L.C. and FID Trading International SARL.
      </p>

      <Button variant="outline" asChild className="mt-6">
        <Link href="/dashboard">
          <ArrowLeft />
          Back to the dashboard
        </Link>
      </Button>
    </div>
  );
}
