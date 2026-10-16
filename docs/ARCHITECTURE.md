# Architecture

One core engine, many companies, many industries, many currencies. Nothing in the
codebase is forked per customer; a customer is *data and configuration*.

## Stack

Next.js (App Router, server components + server actions), React, Prisma on
PostgreSQL (pg driver adapter), Tailwind v4 design tokens, Vitest (unit +
integration against a real database) and Playwright (browser + visual checks).

## Tenancy

```
Organization            the customer (billing, plan, status, people)
  └─ Company            a legal entity with its own books, currency and branding
       └─ everything    carries companyId
User, custom Role       carry organizationId
```

- **Every business row has `companyId`.** Services take the company from the signed-in
  session, never from a URL or form field. The query audit
  (`scripts/audit-tenant-queries.ts`, ratcheted by `tests/unit/tenant-query-audit.test.ts`)
  fails the build if a query on a tenant model is not scoped.
- **People are scoped by organization** (`src/lib/auth/tenant.ts`): an owner sees and manages
  only their own organization's users, roles and companies.
- **The platform operator** is the `DEVELOPER_USERS` list. The platform console
  (`/platform`) shows counts, plan, status and health — never a customer's names,
  balances or ledgers.
- **Isolation is tested**, not assumed: `tests/integration/tenant-isolation.test.ts` exercises
  lists, detail URLs, APIs, exports, search and reports across two tenants.

## Money

Each voucher stores three amounts: the **transaction** currency, **USD** (the fixed
reporting pivot, `*Usd` columns) and the company's **local/books** currency. Any ISO 4217
currency can be a company's books currency (`src/lib/currencies.ts` carries minor units).
Rates are entered per currency pair and date (`/settings/exchange-rates`); a document keeps
the rate it was posted at. Accounting is double-entry; every posting goes through
`src/lib/services/accounting.ts`, inside one database transaction.

## Quantities

Columns named `*Kg` hold **base units for any item** — kilograms, pieces, metres, litres.
The company's unit is `terminology.unit`; `formatQuantityKg()` prints it, and server pages
inherit it from the request (`getCurrentUser()` records it in an AsyncLocalStorage the
formatter reads), so a quantity is never shown in the wrong unit by omission.

## Configuration, not code

| Concern | Where |
|---|---|
| Industry templates (7) — features, words, attribute sets | `src/lib/templates.ts` |
| Module toggles and plan entitlements | `src/lib/features.ts`, `src/lib/entitlements.ts` |
| Words a company uses (Customer/Buyer, Shipment/Consignment…) | `src/lib/terminology.ts` |
| Item attributes per industry | `src/lib/item-attributes.ts` |
| Tax: codes and rates a company enters (no presumed rates) | `src/lib/services/tax.ts` |
| Product brand (platform) | `src/lib/brand.ts` + `PRODUCT_*` env, `docs/REBRANDING.md` |
| Company brand (documents) | Settings → Company profile, `src/components/shared/letterhead.tsx` |

Gating is applied in one place: `can()` in `src/lib/auth/guards.ts` combines the user's
permissions with the company's enabled features, and the navigation is filtered by the
same function — a hidden module is also a refused module.

## Posting and safety rules

- Services own business rules; server actions validate, authorize, call a service, audit.
- `transaction()` (`src/lib/db.ts`) joins an already-open transaction, which is how the
  import wizard previews a file by running the real import and rolling back.
- Financial records are never edited in place: they are reversed or corrected with an audit trail.
- Migrations are **additive only**. Backfills for existing tenants live inside the migration
  that adds the column (FID's backfill is in `20261016100000_company_profile_and_config`).

## Demo and demo mode

`scripts/demo-tenant.ts` builds four fictional companies (UAE/AED general trading,
Morocco/MAD coffee, Pakistan/PKR apparel, UK/GBP distribution) by calling the real
services, in a **separate database**, and refuses to run against anything that is not a demo
database. `DEMO_MODE=1` shows the banner, offers one-click entry and blocks users, roles,
companies and backups.

## Quality rails

| Rail | Command |
|---|---|
| Types, lint, unit + integration | `npm run verify` |
| FID golden master (balances, ledgers, stock, TB/P&L/BS from the backup) | `scripts/gm.sh` |
| Tenant isolation | `tests/integration/tenant-isolation.test.ts` |
| Accessibility (axe, WCAG 2.2 AA) | `node scripts/demo-video/a11y-scan.mjs` |
| Responsive overflow, 360–1920 px | `node scripts/demo-video/responsive-scan.mjs` |
