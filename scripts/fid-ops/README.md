# FID operations scripts

One-off repairs and corrections written for FID Trading's live database. They name
FID's customers, suppliers, documents and companies on purpose.

They are **not part of the product**: nothing in `src/` imports them, they are not run by
the test suite, and a new customer never needs them. They are kept (rather than deleted)
because each is the audit record of a change made to FID's books.

Run from the repository root, e.g. `npx tsx --tsconfig tsconfig.json scripts/fid-ops/audit-live.ts`.
