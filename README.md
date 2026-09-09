# FID Trading — Coffee Trading Management System

An integrated business management system for **FID Trading L.L.C.** (Dubai) and
**FID Trading International SARL** (Casablanca), covering the whole coffee
trading cycle in one place:

```
Purchase contract → Job → Lot / Batch / Container → Goods receipt → Warehouse
   → Sale → Receivable → Receipt → Cash & bank → Landed cost → Profitability
   → Double-entry accounting → Financial statements
```

The two companies share one installation but keep entirely separate books. Data
never crosses between them, and that separation is enforced on the server, not
merely hidden in the interface.

---

## Contents

- [Technology](#technology)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Database](#database)
- [Using Supabase](#using-supabase)
- [Commands](#commands)
- [Finding your way around](#finding-your-way-around)
- [How the business logic works](#how-the-business-logic-works)
  - [Purchase order versus goods receipt](#purchase-order-versus-goods-receipt)
  - [Inventory and warehouses](#inventory-and-warehouses)
  - [Landed cost](#landed-cost)
  - [Multi-currency](#multi-currency)
  - [Cheques](#cheques)
  - [Accounting](#accounting)
  - [Profitability](#profitability)
- [Permissions and roles](#permissions-and-roles)
- [Document numbering](#document-numbering)
- [Testing](#testing)
- [Deployment](#deployment)
- [Backups](#backups)
- [Assumptions](#assumptions)

---

## Technology

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router), React 19 |
| Language | TypeScript, strict mode |
| Database | PostgreSQL 16 |
| ORM | Prisma 7 with the `@prisma/adapter-pg` driver adapter |
| Validation | Zod |
| Styling | Tailwind CSS v4 |
| Components | Radix primitives, hand-built design system |
| Charts | Recharts |
| Money | `decimal.js` — no floating point touches a financial value |
| Auth | Server-side sessions, Argon2id password hashing |
| Tests | Vitest against a real PostgreSQL database |

---

## Getting started

### Prerequisites

- Node.js 20 or later
- PostgreSQL 16 or later
- A database and a role the application can connect as

### Install

```bash
git clone <repository-url>
cd fid-erp
npm install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env` and set at least `DATABASE_URL`, `TEST_DATABASE_URL` and the three
`INITIAL_ADMIN_*` values.

### Create the database

```bash
createdb fid_trading
createdb fid_trading_test
```

Or with `psql`:

```sql
CREATE ROLE fid_app LOGIN PASSWORD 'your-password' CREATEDB;
CREATE DATABASE fid_trading OWNER fid_app;
CREATE DATABASE fid_trading_test OWNER fid_app;
```

### Migrate and initialise

```bash
npm run db:migrate      # apply migrations (development)
npm run db:seed         # permissions, roles, both companies, first admin
```

For a production install:

```bash
npm run db:deploy       # apply migrations without prompting
npm run db:init         # same initialisation, same result
```

The initialisation is idempotent and creates **no sample data**: permissions,
roles, the two companies with their chart of accounts, cash and bank accounts,
warehouses, indicative exchange rates and the first Super Admin. Customers,
suppliers, coffee items and every transaction are yours to enter — the
dashboard's setup checklist walks through it.

### Run

```bash
npm run dev             # http://localhost:3000
```

Sign in with the `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` from your
`.env`. **Change that password immediately after the first sign-in** — the
account is a Super Admin and bypasses every restriction.

Everyone else is created from **Administration → Users**, where each account is
given its roles and the companies it may see. A Dubai user assigned only to FID
Trading L.L.C. cannot reach a Morocco record by any route, including a guessed
URL.

On first sign-in the dashboard shows a setup checklist — warehouses, cash and
bank accounts, coffee items, suppliers, customers, then a trade from purchase
contract through goods receipt to sale and receipt. It is also always available
at **/getting-started**.

---

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string used at runtime, and by migrations when `DIRECT_URL` is unset |
| `DIRECT_URL` | Optional. Direct (non-pooled) connection used only by `prisma migrate`. Required behind a transaction pooler such as Supabase's port 6543 |
| `DATABASE_SSL_CA` | Optional. Path to a root certificate when the provider uses its own CA. Required for Supabase's poolers — `certs/supabase-prod-ca-2021.crt` ships with the repository |
| `TEST_DATABASE_URL` | Separate database for the test suite. **It is truncated between runs** — never point it at real data |
| `SESSION_COOKIE_NAME` | Name of the HTTP-only session cookie |
| `SESSION_TTL_HOURS` | Session lifetime in hours |
| `INITIAL_ADMIN_EMAIL` | Bootstrap Super Admin, consumed by `db:init` / `db:seed` |
| `INITIAL_ADMIN_NAME` | Display name for that account |
| `INITIAL_ADMIN_PASSWORD` | Initial password. Must pass the strength policy |
| `DATABASE_POOL_MAX` | Optional. Connection pool size, default 10. Keep it small behind a pooler |
| `DATABASE_TRANSACTION_TIMEOUT_MS` | Optional. Transaction ceiling, default 20000. Raise it only for a distant database |

No credentials are committed to the repository, and `.env` is git-ignored.

---

## Database

47 tables. The ones that carry the business:

**Organisation** — `companies`, `users`, `roles`, `permissions`,
`role_permissions`, `user_roles`, `user_companies`, `sessions`

**Masters** — `coffee_items`, `customers`, `vendors`, `agents`, `warehouses`,
`shipping_lines`, `expense_categories`

**Traceability** — `lots`, `batches`, `containers`

**Trading** — `purchase_contracts`, `purchase_contract_lines`, `shipments`,
`shipment_status_history`, `shipment_document_status_history`,
`goods_receipts`, `goods_receipt_lines`, `sales_invoices`,
`sales_invoice_lines`

**Inventory** — `inventory_transactions` (the append-only movement ledger),
`inventory_balances` (per batch × warehouse), `stock_transfers`,
`stock_transfer_lines`

**Money** — `receipts`, `receipt_allocations`, `payments`,
`payment_allocations`, `expenses`, `cheques`, `cheque_status_history`,
`cash_bank_accounts`

**Accounting** — `accounts`, `journal_entries`, `journal_lines`

**Platform** — `notifications`, `audit_logs`, `attachments`,
`application_settings`, `number_sequences`, `exchange_rates`

Numeric precision: money `NUMERIC(18,4)`, exchange rates `NUMERIC(18,8)`,
quantities `NUMERIC(18,3)`, unit costs `NUMERIC(18,8)`. Stock is held internally
in **kilograms**; metric tons and bags are entry conveniences that are converted
on the way in.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint |
| `npm test` | Full test suite |
| `npm run verify` | Typecheck + lint + tests |
| `npm run db:migrate` | Create and apply a migration (development) |
| `npm run db:deploy` | Apply migrations (production) |
| `npm run db:seed` | Initialise permissions, roles, companies, first admin |
| `npm run db:init` | The same initialisation, named for production use |
| `npm run db:studio` | Prisma Studio |
| `npm run db:clear -- --confirm` | Delete every transaction and trading record, keeping companies, chart of accounts, cash and bank accounts, warehouses, users and roles. Add `--with-users` to also remove every user except the initial admin |
| `npm run db:reset` | Drop, re-migrate and re-seed. Destroys all data |

---

## Using Supabase

Supabase is plain PostgreSQL, so none of the application logic changes. Three
things need attention: which hostname you can actually reach, the certificate,
and where you run the app relative to the database.

### 1. Use the pooler, not the direct host

Supabase offers three connection strings under **Connect**:

| String | Host | Port | Notes |
|---|---|---|---|
| Direct | `db.<ref>.supabase.co` | 5432 | **IPv6 only** unless you buy the IPv4 add-on. Most machines and many hosts cannot reach it at all |
| Session pooler | `aws-0-<region>.pooler.supabase.com` | 5432 | IPv4. A dedicated connection per client session — use this for a long-running server, and for migrations |
| Transaction pooler | `aws-0-<region>.pooler.supabase.com` | 6543 | IPv4. Connection returned to the pool per transaction — use this for serverless |

The pooler username is `postgres.<project-ref>`, not `postgres`.

If the direct hostname resolves only to an IPv6 address and `ip -6 route get
2001:4860:4860::8888` says the network is unreachable, stop there — no
connection-string tweak will fix it. Use the session pooler for both variables.

### 2. Supply Supabase's certificate

Supabase's poolers present certificates signed by **Supabase's own root CA**,
not by a public authority. Node rejects them out of the box:

```
self-signed certificate in certificate chain
```

The CA is committed at [`certs/supabase-prod-ca-2021.crt`](certs/) — a root
certificate is public information, so there is no secret in the repository.
Point `DATABASE_SSL_CA` at it and the chain verifies properly.

`prisma migrate` does **not** go through the application's driver adapter; the
schema engine opens its own connection and reads TLS settings from the URL. So
the CA is named twice, once per consumer:

```bash
# The application. TLS policy comes from DATABASE_SSL_CA.
DATABASE_URL="postgresql://postgres.PROJECTREF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres?sslmode=require"

# Migrations only. Prisma's own engine, so the CA goes in the URL.
DIRECT_URL="postgresql://postgres.PROJECTREF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres?sslmode=require&sslcert=certs/supabase-prod-ca-2021.crt"

DATABASE_SSL_CA="certs/supabase-prod-ca-2021.crt"
DATABASE_POOL_MAX="10"
```

A password containing `@`, `#`, `/` or `?` must be percent-encoded in the URL —
`@` becomes `%40`, `#` becomes `%23`.

`sslmode=no-verify` also works and needs no certificate file, but it accepts
any certificate presented to it, which defeats the point of TLS. Prefer the CA.

### 3. Create the schema and the first administrator

```bash
npm run db:deploy     # applies every migration to your Supabase database
npm run db:init       # permissions, roles, both companies, chart of accounts, admin
```

Nothing else is inserted — no sample customers, no sample coffee, no invented
transactions. Sign in and the dashboard's setup checklist takes it from there.

### 4. Put the app near the database

This matters more than anything above. Every query costs a network round-trip,
and a page that runs a dozen of them pays that latency a dozen times:

| Server ↔ database | Round-trip | Typical page | Posting a contract |
|---|---|---|---|
| Same region | 1–5 ms | under 100 ms | well under a second |
| Different continent | 150–250 ms | 1.5–3 s | 5–9 s |

Those figures are measured, not estimated: a three-container purchase contract
posts in about 8 seconds from Pakistan to a database in Tokyo, against a
fraction of a second locally. The books come out identical — it is only slow.

If the application feels slow, it is almost always geography, not the code.
Deploy to the region your Supabase project lives in — or create the project in
the region you deploy to. `DATABASE_TRANSACTION_TIMEOUT_MS` raises the 20-second
ceiling on posting transactions if you are stuck with a distant database — a
large document could otherwise run out of time mid-post — but it treats the
symptom.

### Connection limits

Keep `DATABASE_POOL_MAX` well inside your project's pooler allowance, and be
aware that a script run alongside the server draws from the same budget. When a
free-tier project runs out of client connections, Supavisor reports it as
`password authentication failed` rather than as a limit — misleading enough to
be worth knowing before you start doubting your password.

### What not to point at Supabase

`TEST_DATABASE_URL`. The integration suite truncates every table between runs.
Keep it on a local database.

### Row Level Security

Leave RLS off, or leave it on and connect as the `postgres` owner. This
application is the only client of its database and does its own authorisation:
every query is scoped by company on the server, and permissions are checked
before a service is ever reached. Supabase's client libraries, anon key and
publishable key are not used at all — the browser never talks to the database,
only to your Next.js server.

---

## Finding your way around

The application is built for people who did not choose it and will not be
trained on it.

**The setup checklist.** A company with nothing in it shows a checklist instead
of empty charts: warehouses, cash and bank accounts, coffee, suppliers,
customers, then a trade from purchase contract through goods receipt to sale and
receipt. Each line links to the screen that does the job and ticks itself off
when the record exists. It stays on the dashboard until every line is done, and
lives permanently at **/getting-started** together with an explanation of how
the pieces connect.

**⌘K / Ctrl-K.** One box that both jumps to screens and searches records —
contracts, shipments, invoices, customers, suppliers. Screen matching is
filtered by your permissions; record matching is scoped by the server to your
active company.

**The "+ New" menu.** The nine things people create, grouped as Trade, Money and
Records, available from every screen. Entries you have no permission to use are
not shown, and the routes behind them check the same permission again.

**Prerequisite gates.** A form that could not possibly succeed is not shown. Ask
for a sales invoice with no customers and no stock and the screen says which of
the two is missing and links to it, rather than presenting empty dropdowns.

**Empty states that do something.** Every list that has nothing in it explains
what would put something there and offers the button that starts it.

---

## How the business logic works

All of it lives in `src/lib/services/`. Nothing in the interface calculates a
financial or stock figure — the pages read, the services decide.

### Purchase order versus goods receipt

These are separate events, deliberately.

**Approving a purchase contract** creates the supplier liability, opens a *job*
(the profitability object), and creates the lots, containers and batches. The
coffee is owned, so it is taken into **Inventory in Transit** — but not a single
kilogram is in a warehouse yet:

```
Dr  Inventory in Transit
    Cr  Accounts Payable — supplier
```

**A goods receipt** is what makes coffee sellable. It names the warehouse the
containers physically went into, and can be raised as many times as the delivery
takes:

```
Dr  Inventory — Coffee Stock
    Cr  Inventory in Transit
```

Over-receipt against the ordered quantity is refused.

### Inventory and warehouses

`inventory_transactions` is an append-only movement ledger and is the only
authority on stock. Two caches are recomputed from it inside every posting
transaction, so neither can drift:

- `inventory_balances` — stock per batch × warehouse ("where is it?")
- `batches.*QuantityKg` — stock per batch across warehouses ("how much is there?")

Stock states: **ordered** → **in transit** → **on hand** → **reserved** →
**sold**. Available is on hand minus reserved.

A draft sales invoice *reserves* stock; posting converts the reservation into an
actual movement. Two salespeople cannot promise the same tonnage.

**Transfers** post a matched `TRANSFER_OUT` / `TRANSFER_IN` pair inside one
transaction, so company-level stock is never duplicated and never dips while
goods are on the road:

```
Warehouse A 100,000 KG  →  transfer 20,000  →  A 80,000 + B 20,000 = 100,000
```

Negative stock is blocked by default and can only be enabled by an
administrator, in Settings, with the change recorded in the audit trail.

### Landed cost

The cost of a kilogram of coffee is not what the supplier charged for it:

```
landed cost per KG = (goods value + capitalised direct costs) / ordered KG
```

Contract freight and other direct charges are spread across the lines by value
at the point of approval. Costs that arrive later — clearing, customs, port
charges, inland transport — are capitalised when they are posted, and do two
things:

1. Raise the landed cost of the coffee still in stock, so the balance sheet
   carries it at the right value.
2. **True up** the share belonging to coffee already sold, moving it straight
   from inventory into cost of goods sold.

Without step 2, a late freight invoice would inflate the inventory asset for
coffee that had already left the warehouse. Expense categories carry a
`capitaliseByDefault` flag: freight, insurance, customs, clearing, port,
transport, documentation, labour, loading and inspection capitalise; bank
charges, agent commission and storage are period costs.

### Multi-currency

The group currency is **USD**. Dubai's local currency is **AED**, Morocco's is
**MAD**.

| | Dubai | Morocco |
|---|---|---|
| Customer ledger | USD | MAD |
| Supplier ledger | USD | USD |
| Local expenses | AED | MAD |
| Cash / bank | AED and USD | MAD and USD |

Exchange rates are always expressed as **units of the quoted currency per
1 USD**. Converting to USD divides; converting from USD multiplies.

Every voucher permanently stores three views of the same amount, all captured at
posting time:

| | |
|---|---|
| Transaction currency | what actually moved |
| USD equivalent | the group reporting anchor |
| Local currency | the company's own reporting |

along with the rates used. **Changing the rate table tomorrow cannot restate a
voucher posted today.**

Dubai settles USD invoices in AED at a rate negotiated per payment, so a receipt
accepts either a rate *or* a stated USD equivalent and derives the other:

```
AED 100,000 with an agreed USD value of 27,240
  → rate 3.67107195 stored on the voucher
  → AED bank rises by exactly AED 100,000
  → the customer's USD receivable falls by exactly USD 27,240
```

Where a settlement rate differs from the rate a balance was booked at, the
resulting difference is recognised through **foreign currency revaluation** — a
periodic, local-currency-only entry to FX Gain/Loss, the same way mainstream
accounting packages handle it.

### Cheques

A cheque is an instrument with its own life, not a note on a payment. Treating
one as cash the day it arrives overstates the bank and makes a bounce impossible
to unwind cleanly.

| Status | Inbound entry |
|---|---|
| Received | Dr Cheques on Hand / Cr Accounts Receivable |
| Deposited | none — the asset has not changed, only its location |
| Cleared | Dr Bank / Cr Cheques on Hand |
| Bounced | Dr Accounts Receivable / Cr Cheques on Hand — the debt is reinstated |
| Cancelled | as bounced |

Outbound cheques mirror this through *Cheques Issued — Not Cleared*. A bounced
cheque can never be mistaken for cleared cash.

### Accounting

Genuine double entry. Every balance in the system — receivables, payables, cash,
inventory value, revenue, cost — is derived from journal lines written through
one posting service. No other module may touch a financial balance, which is
what stops the subsystems drifting apart.

Entries balance **exactly** in USD. The local-currency columns are derived from
the USD figures; sub-cent conversion noise is absorbed on a *translated* line
(never on a line already in the local currency, which is exact by definition),
and anything larger is rejected as a bug.

Posted documents are never edited or deleted. Correction is by **reversal**: a
mirrored contra entry at the original rates. Both entries stay posted and both
stay in the balances — the contra is what cancels the original, so excluding the
original as well would apply the reversal twice.

The chart of accounts is deliberately compact, aiming at QuickBooks-level
familiarity rather than a thousand-line statutory chart. Control accounts carry
a `systemKey` so the posting engine never depends on a hard-coded account code.

Reports: Trial Balance, General Ledger, Profit & Loss, Balance Sheet, Cash Flow,
Cash Book / Bank Book, Journal, Customer and Supplier Ledgers (dual USD / local
view), Receivables and Payables ageing, Expense reports, Financial Position.

### Profitability

```
Allocated Landed Cost = sold KG × the batch's current landed cost per KG
Gross Profit          = Sales Revenue − Allocated Landed Cost
Net Profit            = Gross Profit  − period job costs
Profit per KG         = Net Profit / sold KG
```

Two things this deliberately does not do:

- It never counts unsold coffee as revenue. A half-sold job shows the margin on
  the half that sold; the rest stays on the balance sheet as inventory.
- It never double-counts freight. Capitalised costs are already inside landed
  cost and reach profit through cost of goods sold; only genuine period costs
  appear as "other costs".

There is no stored net profit column anywhere in the schema, and no screen lets
anyone type one.

---

## Permissions and roles

73 permissions across 11 modules. Ten seeded roles: Super Admin, Company Admin,
Manager, Accounts, Sales, Purchase, Warehouse, Shipment/Logistics, Staff, Read
Only.

Two permissions are especially load-bearing:

- **`purchases.cost.view`** hides unit cost and landed cost wherever they
  appear, so a sales user cannot see what the coffee cost.
- **`profits.view`** hides margin, net profit and shipment profitability.

Both are enforced on the server. Hiding a button is a convenience; the check
that matters happens before any data is read.

Company access is a financial control: a user only sees and posts into the
companies assigned to them, and the scope comes from the session, never from the
request. A cross-company id returns *not found* rather than *forbidden*, so the
interface cannot be used to probe which records exist elsewhere.

---

## Document numbering

Every document carries its company prefix, so it is identifiable on sight:

```
FID-DXB-PO-000001     Dubai purchase contract
FID-DXB-GRN-000004    Dubai goods receipt
FID-MA-SI-000042      Morocco sales invoice
FID-MA-RV-000018      Morocco receipt voucher
```

Numbers are allocated with a single `INSERT … ON CONFLICT DO UPDATE … RETURNING`
statement, so two simultaneous posts can never be handed the same number.

---

## Testing

```bash
npm test
```

113 tests over six suites, run against a real PostgreSQL database.

| Suite | Covers |
|---|---|
| `unit/money` | Decimal arithmetic, unit and currency conversion, proportional allocation |
| `unit/calculations` | Contract totals, sales lines, status rules, ageing, subledger legs |
| `integration/trading-flow` | Purchase → goods receipt → warehouse stock → partial sales → transfer → landed cost → profitability |
| `integration/multi-currency` | Rate entry both ways, historical rate integrity, dual-view ledger, cheque life cycle, FX revaluation |
| `integration/integrity` | Permissions, company isolation, transaction atomicity, concurrency, reversals |
| `integration/reports` | Trial balance, P&L, balance sheet, financial position, general ledger, cash book, cash flow, journal, dashboard |

The integration tests use `TEST_DATABASE_URL` and **truncate it between runs**.

---

## Deployment

The application is a standard Next.js server-rendered app and needs a Node
runtime plus a managed PostgreSQL database. It runs on Vercel, Railway,
Render, Fly.io or your own server.

1. Provision PostgreSQL and take its connection string. For Supabase, see
   [Using Supabase](#using-supabase) — it needs `DIRECT_URL` as well.
2. Set the environment variables from the table above. Use a strong
   `INITIAL_ADMIN_PASSWORD` and rotate it after first sign-in.
3. Build and release:

```bash
npm ci
npm run build
npm run db:deploy     # apply migrations
npm run db:init       # first run only: permissions, roles, companies, admin
npm run start
```

Notes for production:

- Everything runs on the Node runtime; there is no Edge-compatible path, because
  the posting engine needs real database transactions.
- Session cookies are set `Secure` when `NODE_ENV=production`, so serve over
  HTTPS.
- `DATABASE_POOL_MAX` should be sized to your database's connection limit —
  small behind a pooler, and 1–3 per instance on serverless.
- Behind a connection pooler, set `DIRECT_URL` so migrations bypass it.
- Run `npm run verify` in CI before releasing.

---

## Backups

This system holds money, stock and supplier balances. Back the database up.

```bash
pg_dump --format=custom --file=fid-$(date +%F).dump "$DATABASE_URL"
```

Take a nightly dump, keep at least 30 days, store it off the database host, and
**restore it somewhere at least once** — an untested backup is not a backup.
Nothing is ever hard-deleted from the financial records, so a restore recovers a
complete audit trail.

---

## Assumptions

Recorded where the requirements left room for judgement:

1. **Title passes at shipment.** Approving a purchase contract recognises the
   supplier liability and takes the coffee into *Inventory in Transit*. This
   matches how FID trades — cargo is routinely sold while still on the water.
2. **Landed cost is allocated by quantity.** Freight and direct costs are spread
   over a job's batches in proportion to ordered kilograms. For a single-commodity
   shipment this is both intuitive and defensible; value-based allocation would
   be a small change to `applyLandedCost`.
3. **Cost of goods is frozen at posting, then trued up.** Later capitalised costs
   post the difference for already-sold coffee directly to cost of goods sold, so
   the ledger keeps agreeing with the profitability report.
4. **FX differences are recognised by revaluation**, not silently inside the
   settlement voucher — the treatment QuickBooks and Xero use.
5. **A party's ledger is kept in that party's own currency.** Dubai customers in
   USD, Morocco customers in MAD, overseas suppliers in USD for both. A voucher
   in a currency that cannot be expressed exactly against that ledger is
   rejected rather than posted at an approximated rate.
6. **Depositing a cheque posts no entry.** The asset has not changed, only its
   location; only clearing moves money into the bank.
7. **Alerts are generated on demand** rather than by a background worker, since
   this deployment has no scheduler. "Check now" on the Alerts screen regenerates
   them; a cron job calling the same service would work unchanged.
8. **Attachments are modelled but not yet wired to a storage backend.** The
   `attachments` table, its permissions and its relations exist; connecting S3 or
   equivalent is a contained change.
