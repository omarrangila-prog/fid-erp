# FID Trading — Handover

Coffee trading, inventory, shipment and accounting management for
**FID Trading L.L.C.** (Dubai) and **FID Trading International SARL**
(Casablanca), operated as two companies whose data never mixes.

This document states what the system does, what has been verified, and — just
as importantly — what it does not yet do. Read the last section before relying
on it for anything statutory.

---

## What it manages

| Area | Covered |
|---|---|
| Purchasing | Contracts, multi-container, lot and batch traceability, partial goods receipts |
| Inventory | Per-warehouse balances, batch/lot/container tracking, transfers, movement ledger |
| Shipments | Job workflow from contract to delivery, ETA tracking, document status, loading sheet |
| Sales | Batch-specific invoicing out of a named warehouse, partial sales |
| Cash | Receipts, payments, expenses, petty cash, full cheque lifecycle |
| Accounting | Double entry throughout, manual journal vouchers, currency revaluation, period close |
| Costing | Landed cost capitalised from freight and clearing, with cost-of-sales true-up |
| Reporting | Business overview, P&L, balance sheet, trial balance, general ledger, cash flow, ageing, profitability, reconciliation |
| Currencies | USD, AED, MAD — held separately, never merged, historical rates immutable |
| Control | Role-based permissions enforced server-side, full audit trail, company isolation |

---

## What has been verified

Everything below was measured on this build, not estimated.

**Books reconcile.** Ten independent checks in each company compare the control
accounts against the sub-ledgers that feed them, and the stock ledger against
the warehouse balances. All twenty pass. The checks are re-run live in the
application at **Reports → Reconciliation**, so this is not a one-off claim.

| Check | Dubai | Morocco |
|---|---|---|
| Trial balance balanced | ✓ | ✓ |
| Balance sheet balances | ✓ | ✓ |
| Every entry balances individually | ✓ | ✓ |
| Receivables tie to the ledger | ✓ | ✓ |
| Payables tie to the ledger | ✓ | ✓ |
| Inventory asset ties to valued stock | ✓ | ✓ |
| Cost of sales ties to profitability | ✓ | ✓ |
| Stock movements equal warehouse balances | ✓ | ✓ |
| Warehouse balances roll up to batch totals | ✓ | ✓ |
| No negative stock | ✓ | ✓ |

**Tests.** 152 unit and integration tests, and 37 browser tests, all passing.
Coverage includes the trading flow end to end, multi-currency behaviour,
reporting, permissions, company isolation, atomic rollback, concurrency,
reversals, period close and awkward inputs.

**Layout.** Verified in a real browser at nineteen widths from 320px to 2560px
across nine screens — no horizontal overflow anywhere.

**Accessibility.** axe reports no WCAG 2.0 / 2.1 A or AA violations on nine
screens including sign-in.

**Every page loads.** 55 routes return successfully with a real session.

**Security.** Passwords hashed with Argon2id. Sessions are opaque tokens stored
as a SHA-256 digest. Login is throttled per account and per address.
Permissions and company scoping are enforced on the server, not by hiding
buttons — a record belonging to the other company returns "not found" rather
than "forbidden", so its existence cannot be probed. No credentials are in the
repository.

---

## Running it

```bash
npm ci
npm run db:deploy     # apply the schema
npm run db:init       # permissions, roles, both companies, chart of accounts, first admin
npm run build
npm run start
```

The first administrator comes from `INITIAL_ADMIN_EMAIL` and
`INITIAL_ADMIN_PASSWORD` in `.env`. **Change that password after the first
sign-in** — it is a Super Admin and bypasses every restriction.

No sample data is created. Customers, suppliers, coffee and every transaction
are entered by the business; the dashboard shows a setup checklist until that
is done.

Full setup, environment variables, Supabase notes and business-logic detail are
in [`README.md`](../README.md).

---

## Day-to-day use

- **⌘K / Ctrl-K** jumps to any screen and searches contracts, invoices,
  customers and shipments.
- **+ New** creates anything from anywhere, filtered to what the person may do.
- The **company badge** carries its country flag, so nobody enters Dubai work
  while looking at Morocco.
- **Reports → Reconciliation** is worth a weekly look. If a check ever fails,
  do not adjust a figure to make it match — the report names the two totals
  that disagree so the underlying transaction can be found.
- **Settings → Accounting period** freezes a reported month. After closing,
  nothing can be posted on or before that date by anybody until it is reopened,
  and both actions are recorded in the audit trail.

---

## Not included

This is a working trading and accounting system. It is **not** a complete
statutory accounting package, and the following are genuinely absent rather
than partially built:

| Missing | Consequence |
|---|---|
| **VAT / TVA** | No tax on invoices and no VAT return. UAE FTA and Moroccan TVA filing must be done outside the system. **This is the significant one.** |
| **Credit notes / sales returns** | A posted invoice can be reversed, but a credit note cannot be issued against an invoice that is being kept |
| **Vendor credits / debit notes** | Same, on the purchase side |
| **Customer and supplier advances** | Money received before an invoice has no advance account to sit in |
| **Bank reconciliation** | The ledger cannot be ticked against a bank statement |
| **In-app backup and restore** | The database host's own backups apply; there is no backup module inside FID |
| **Physical stock count** | No count sheet or variance posting |
| **PDF export of reports** | CSV export exists on list screens; there is no PDF pack |
| **Document attachments** | Modelled in the database but not connected to file storage, so uploads do not work |

Roughly thirty-five further report variants named during specification are also
not built; the reports that exist are the ones a trading business uses daily.

**Recommended order if this is taken further:** VAT first, then credit notes
and advances, then bank reconciliation, then PDF export.

---

## Where things live

- Application and schema: this repository
- Database: PostgreSQL 17 (currently a Supabase project in `ap-northeast-1`)
- Deployment note: the server should run in the same region as the database.
  Across continents each query costs ~158 ms and a posted contract takes about
  eight seconds; in-region it is sub-second. This is geography, not code.
