# FID Trading ERP — build state

Coffee-beans trading ERP for **FID Trading L.L.C.** (Dubai, local AED) and
**FID Trading International SARL** (Casablanca, local MAD). Group currency USD.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript strict · Tailwind v4 ·
PostgreSQL 16 · Prisma 7 (driver adapter `@prisma/adapter-pg`) · Zod ·
Recharts · Radix primitives · Vitest · Argon2id.

Databases: `fid_trading` (dev), `fid_trading_test` (tests). Role `fid_app`.

## Done and verified — 100 automated tests passing

### Domain / schema (47 tables, one migration `init_fid_coffee_erp`)
Companies, users, roles, permissions, sessions; coffee items, lots, containers,
warehouses, agents, customers, suppliers, shipping lines, expense categories;
purchase contracts + lines, shipments (jobs), goods receipts + lines, batches,
inventory transactions, inventory balances, stock transfers + lines; sales
invoices + lines; receipts/payments + allocations, cheques + status history,
expenses; chart of accounts, journal entries + lines; notifications, audit logs,
attachments, settings, number sequences, exchange rates.

### Engines
- **Accounting** (`services/accounting.ts`) — one posting service; USD balance
  enforced exactly; local-currency drift absorbed on *translated* lines only;
  `localOnly` lines for FX revaluation; reversal writes a contra entry and both
  stay POSTED (a fix for a double-reversal bug the tests caught).
- **Inventory** (`services/inventory.ts`) — append-only movement ledger, two
  caches (`inventory_balances` per batch×warehouse, batch totals) recomputed in
  every posting transaction. Row locks + availability checks. Transfers post a
  matched OUT/IN pair so company stock never dips or duplicates.
- **Landed cost** (`services/landed-cost.ts`) — capitalised shipment costs
  raise batch landed cost and true up the already-sold share straight to COGS,
  keeping the GL equal to the profitability report.
- **Multi-currency** — every voucher stores transaction / USD / local amounts
  and its own rate, permanently. Receipts accept a rate *or* a stated USD
  equivalent (Dubai's per-payment negotiated rate) and derive the other.
- **Cheques** — Received → Deposited → Cleared / Bounced / Cancelled, each with
  the correct entry; a bounced cheque reinstates the receivable.
- **FX revaluation** (`services/revaluation.ts`) — periodic, local-only.

### Services also complete
purchase, goods-receipt, stock-transfer, sales, receipt, payment, expense,
shipment, profitability, receivables/payables, stock queries, ledger (dual
view), reports (trial balance, P&L, balance sheet, cash flow, GL, cash book,
journal, expense report, financial position), dashboard, notifications, search,
audit, numbering (company-prefixed: `FID-DXB-PO-000001`), settings,
chart-of-accounts provisioning, setup status (onboarding checklist),
initialisation seed (no sample data).

### Key business rules encoded
- Approving a PO creates the supplier payable + job + lots/containers/batches
  and puts goods in **Inventory in Transit** — it does **not** create warehouse
  stock. A **goods receipt** (full or partial, warehouse mandatory) does that.
- Sales deplete a specific batch **in a specific warehouse**; negative stock is
  blocked by default.
- Drafts reserve stock; posting converts the reservation.
- Profit never counts unsold coffee as revenue.

## Verified test suites (`npm test` → 100 passed)
`tests/unit/money`, `tests/unit/calculations`,
`tests/integration/trading-flow` (PO → GRN → sale → transfer → landed cost),
`tests/integration/multi-currency` (rates, dual ledger, cheques, revaluation),
`tests/integration/integrity` (permissions, company isolation, atomicity,
concurrency, reversals).

## UI — done
Design tokens; primitives (button, card, badge, input/money/qty, field, table,
dialog/sheet, confirm, combobox, feedback, data-table with mobile card mode);
app shell (collapsible sidebar groups, mobile bottom nav, topbar with the ⌘K
command palette, global "+ New" menu, company switcher, user menu); login;
company selection; **dashboard** with two states — an onboarding checklist while
the company is empty, live figures and five charts once it is trading;
**/getting-started** (the trade end to end, plus the four rules the system
enforces); prerequisite gates in place of forms that could not yet succeed;
empty states that link to the screen that fills them; master form (spec-driven,
shared by all masters); every list, detail and report screen.

`npm run build` passes.

## Verification (last run)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npx eslint .` | 0 errors, 0 warnings |
| `npm test` | 113 passed across 6 suites |
| `npm run build` | succeeds, 68 routes |
| Clean-database migrate + seed | succeeds |
| Route smoke test (real session) | 51/51 render on an empty database, no dead links |
| Company isolation over HTTP | cross-company ids return 404 |
| Permission enforcement over HTTP | all allow/refuse cases correct; cost and profit hidden from a sales user |
| Books | trial balance and balance sheet balance in both companies; GL cost of sales agrees with the profitability report |

## Commands
`npm run dev` · `npm run build` · `npm test` · `npm run db:migrate` ·
`npm run db:seed` = `npm run db:init` (initialisation, no sample data) ·
`npm run db:clear -- --confirm` (empty the business data, keep the install) ·
`npm run verify` (typecheck + lint + test)

Admin credentials come from `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD`
in `.env`; nothing is hard-coded. No demo users and no sample data exist.
