import Link from 'next/link';

export default function RootNotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-paper px-5">
      <div className="max-w-md text-center">
        <div className="mx-auto grid size-10 place-items-center rounded-lg bg-forest-900 text-[11px] font-bold text-gold-300">
          FID
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-tight text-ink">Page not found</h1>
        <p className="mt-2 text-sm text-ink-muted">
          The address you followed does not lead anywhere in this application.
        </p>
        <Link
          href="/dashboard"
          className="mt-6 inline-flex h-10 items-center rounded-lg bg-forest-800 px-4 text-sm font-medium text-white transition-colors hover:bg-forest-700"
        >
          Go to the dashboard
        </Link>
      </div>
    </main>
  );
}
