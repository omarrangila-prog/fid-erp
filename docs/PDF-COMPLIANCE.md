# FID Morocco — Accounting & Reporting Requirements: compliance report

Checked against the client's checklist for **FID Trading International S.A.R.L.**
(Casablanca), section by section, on 21 September 2026.

An item is marked ✅ only where the screen works, the service behind it works,
the database holds the right values, the accounting posting is right, the
related ledgers and reports move with it, real data was used, and a test
covers it. Everything else carries a weaker mark and says why.

| Mark | Meaning |
|---|---|
| ✅ | Built and tested |
| 🟡 | Built, could be better |
| 🟠 | Partly built |
| ❌ | Missing |
| 🐛 | Built but faulty |
| ⚪ | Not applicable |

## How this was verified

Three kinds of evidence sit behind the marks below.

**The live books.** Every reconciliation was run read-only against the client's
own database (FID-MA, 63 journal entries, 184 lines, 11 invoices, 15 expenses,
7 batches, 4 shipments). The reconciliation battery passes 17 of 17 checks, and
the figures tie:

| Check | Shipment view | Company view |
|---|---|---|
| Revenue | 292,010.90 | 292,010.90 |
| Cost of goods sold | 208,090.92 | 208,090.92 |
| Closing stock | 218,517.02 | 218,517.02 (balance sheet inventory) |
| Trial balance | debit 766,661.72 | credit 766,661.72 |
| Balance sheet | assets 558,570.81 | liabilities 473,746.64 + equity 84,824.17 |

**Service tests.** 786 tests over 70 files, run against a separate test
database. `tests/integration/pdf-compliance.test.ts` and
`tests/integration/balance-sheet-heads.test.ts` were written for this
checklist specifically.

**Browser tests.** `tests/e2e/pdf-compliance.spec.ts` drives section 14
through the application itself; `tests/e2e/report-centre.spec.ts` opens every
report in the catalogue and checks the exports.

---

## Section 0 — Objective

| # | Requirement | Status | Where | Evidence |
|---|---|---|---|---|
| 0.1 | One integrated accounting system | ✅ | Whole application | One Postgres database, one posting engine (`src/lib/services/accounting.ts`) |
| 0.2 | Accurate shipment-level profitability | ✅ | Profitability → Statement | `getShipmentProfitability`; revenue and COGS tie to the company P&L to the cent |
| 0.3 | Complete company-wide accounting | ✅ | Reports → P&L, Trial Balance, Balance Sheet | Live: TB balanced, BS balanced |
| 0.4 | Same underlying system for both | ✅ | — | Both read the same `journal_lines`; shipment figures are a view over them |
| 0.5 | Not two disconnected sets of numbers | ✅ | — | `pdf-compliance` §12.14/12.15: shipment revenue = company revenue |
| 0.6 | A transaction is entered once | ✅ | Invoices, expenses, receipts | One document, one posting; sources on live: purchase 8, sales 17, receipt 17, expense 17, manual 3, adjustment 1 |
| 0.7 | Updates all applicable ledgers | ✅ | Customer/supplier/cash/stock ledgers | `accounting-invariants`: control accounts equal the sub-ledgers |
| 0.8 | Updates all applicable reports | ✅ | Every report | Reports are queries over posted lines; nothing is a stored summary |
| 0.9 | No duplicate manual entry needed | ✅ | — | The journal voucher is for corrections and accruals only |

## Section 1 — Core accounting structure

| # | Requirement | Status | Where | Evidence |
|---|---|---|---|---|
| 1.1–1.5 | Shipment/lot accounting: landed cost, stock, sales, profit | ✅ | Profitability, Shipment Cost Report | `pdf-compliance` §2.34–2.47 checks every measure on a real trade |
| 1.6 | Viewable independently | ✅ | `/profitability?view=statement` | One column per shipment, total on the right |
| 1.7 | Still connected to company accounting | ✅ | — | Same ledger lines; §10 reconciliation below |
| 1.8–1.12 | Company P&L, trial balance, balance sheet for the entity | ✅ | Reports | Live figures above |
| 1.13–1.17 | Sales, purchases, direct expenses, inventory all reach both | ✅ | — | `pdf-compliance` §12.9, §12.11–12.13 |
| 1.18–1.19 | No duplicate posting; nothing counted twice | ✅ | — | `accounting-invariants` "a document posts once and only once"; §13.3 below |

## Section 2 — Shipment-wise accounting and costing

### 2A Mandatory shipment/lot reference

| # | Requirement | Status | Where | Evidence |
|---|---|---|---|---|
| 2.1–2.4 | Purchase, sale, stock movement and direct expense carry the reference | ✅ | PO, invoice, receipt, expense voucher | Live: all 7 batches carry a shipment, a lot and a container |
| 2.5 | Traceable after posting | ✅ | Every document screen | `pdf-compliance` §2 "follows the order reference all the way through" |
| 2.6 | Searchable / filterable | ✅ | Trial balance, analysis, sales-by, expenses | Trial-balance shipment filter tested in the browser (§14.16) |
| 2.7 | One reference joins purchase → stock → sale → expense → profit | ✅ | — | Same test as 2.5 |

### 2B Container as lot

| # | Requirement | Status | Where | Evidence |
|---|---|---|---|---|
| 2.8–2.12 | A container can be its own lot, stored, many per order, separately costed, visible in stock | ✅ | PO, loading sheet, receive dialog, batches | `order-shipments` (29 tests) covers 3- and 6-container orders, partial arrival and partial receipt |

### 2C Direct cost categories

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 2.13–2.29 | Purchase value, supplier charges, ocean freight, insurance, customs, import taxes, port, clearing, transport, handling, inspection, fumigation, documentation, demurrage, detention, shipment warehouse charges, other | ✅ | 29 shipment categories on the live company; `pdf-compliance` asserts the full list is present. Fumigation, demurrage and detention were added for this checklist |
| 2.30–2.33 | Postable to a shipment, appear in costing, not duplicated, reach company accounting | ✅ | §12.9: each shipment's capitalised total equals the expenses behind it, by category |

### 2D Shipment profitability report

| # | Requirement | Status | Where | Evidence |
|---|---|---|---|---|
| 2.34–2.40 | Purchased quantity, purchase value, direct expenses, by category, total direct, total landed, per KG | ✅ | Profitability → Statement | Each category is its own line; `pdf-compliance` checks 20,000 KG / 80,000 / 900 / 80,900 / 4.045 per KG |
| 2.41–2.45 | Quantity sold, sales value, average selling price, quantity remaining, closing stock value | ✅ | Same | Average selling price and closing stock value were added for this checklist |
| 2.46–2.47 | Gross profit and percentage | ✅ | Same | Checked in the same test |
| 2.48–2.49 | Real data, nothing hardcoded | ✅ | — | §12.16: an empty company reports zero, not a sample |
| 2.50 | Drill back to source | ✅ | Statement and costing report | Column headers link to the shipment; each cost line links to its voucher |
| 2.51–2.54 | Expense, remaining, sales and received quantities reconcile | ✅ | — | §12.9, §12.11–12.13: received = sold + on hand, to three decimals |

## Section 3 — General and overhead expenses

| # | Requirement | Status | Where | Evidence |
|---|---|---|---|---|
| 3.1–3.5 | A separate kind, needing no shipment, never touching landed cost, reaching the company P&L | ✅ | Expense voucher → "General company expense" | Browser §14.5–14.7: +900 USD on the company P&L, no shipment touched |
| 3.6–3.14 | Rent, salaries, fuel, meals, telephone, travel, professional fees, utilities, administration | ✅ | Expense categories | 14 general categories on the live company |
| 3.15 | More categories without code changes | ✅ | "Add New Category" on the voucher | `expense-category-quick` |
| 3.16–3.21 | Optional allocation by weight, sales value, percentage or equally, over chosen shipments | ✅ | Reports → Overhead Allocation | `pdf-compliance` §3C runs all four bases |
| 3.22–3.24 | Transparent, adds to the expense exactly, no duplication | ✅ | Same | Each basis's shares sum to the expense; one active allocation per period |
| 3.25–3.28 | The original expense stays visible, posted, and distinguishable from the management view | ✅ | — | Expense stays POSTED at full value; allocation writes no journal line |

## Section 4 — Profit and loss reporting

| # | Requirement | Status | Where | Evidence |
|---|---|---|---|---|
| 4.1–4.6 | Shipment P&L with sales less purchase and direct costs | ✅ | Profitability → Statement | §2.34–2.47 |
| 4.7 | Not presented as the official company P&L | ✅ | — | Separate screens; the statement says the overhead share is a management figure |
| 4.8–4.13 | Company P&L with overheads deducted to a net result | ✅ | Reports → Profit & Loss | Live: revenue 292,010.90, COGS 208,090.92, net 84,824.17 |
| 4.14–4.17 | Monthly, quarterly, annual, custom range | ✅ | Period picker + "Display columns by" | Browser §14.9/14.10 |
| 4.18 | Prior-period comparison | ✅ | "Compare" | Previous period and previous year, with change and % |
| 4.19–4.21 | Filters affect the source data; a single day works | ✅ | — | Browser §14.10: one day returns exactly that day's 900 USD |

## Section 5 — Trial balance

| # | Requirement | Status | Where | Evidence |
|---|---|---|---|---|
| 5.1–5.3 | Generated from the double-entry system, not kept by hand | ✅ | Reports → Trial Balance | Built from `journal_lines` at request time |
| 5.4–5.9 | Opening debit/credit, period movements, closing debit/credit | ✅ | Same | Browser §14.11 checks all four column groups |
| 5.10–5.16 | Filters: date, currency, account category, customer, supplier, warehouse, shipment | ✅ | Filter bar | Browser §14.15–14.17: 12 rows → 7 in USD |
| 5.17–5.20 | Totals shown, debits = credits, difference zero | ✅ | Same | Live: 766,661.72 both sides |
| 5.21–5.22 | A discrepancy is reported; an unbalanced posting cannot corrupt it | ✅ | Badge + difference line | §13.1: an unbalanced entry is refused and leaves nothing behind |

## Section 6 — Balance sheet

| # | Requirement | Status | Where | Evidence |
|---|---|---|---|---|
| 6.1–6.2 | Any as-at date, including historical | ✅ | Reports → Balance Sheet | Browser §14.13/14.14; a date before trading shows nothing |
| 6.3–6.12 | Cash, bank, receivables, inventory, supplier advances, other advances, deposits, prepayments, fixed assets, other assets | ✅ | Chart of accounts → Balance Sheet | `balance-sheet-heads` posts to every head and checks its group |
| 6.13–6.21 | Payables, loans, financing, unpaid and accrued expenses, taxes, customer advances, related party, other | ✅ | Same | Same test |
| 6.22–6.26 | Share capital, owner's current accounts, retained earnings, current-year result, other reserves | ✅ | Same | Same test; the current-year result is derived, not an account |
| 6.27–6.31 | Totals calculated, assets = liabilities + equity, imbalance visible | ✅ | Same | Live: 558,570.81 = 473,746.64 + 84,824.17, with a badge when it does not |

## Section 7 — Automatic posting and ledger integration

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 7.1–7.4 | Customer and supplier ledgers, AR and AP | ✅ | §12.3/12.4: ledgers, ageing and control accounts agree |
| 7.5–7.6 | Cash and bank accounts | ✅ | §12.5/12.6: every drawer equals its GL account |
| 7.7 | Petty cash where separately configured | ⚪ | Supported as its own account type; none configured for Morocco |
| 7.8 | Money moves once | ✅ | `accounting-invariants` "does not double-count" |
| 7.9–7.13 | Inventory quantity and value, by lot and warehouse, kept in step | ✅ | §12.7/12.8 |
| 7.14–7.16 | Direct and general expense ledgers, kept apart | ✅ | Expense report splits capitalised, shipment-period and general |
| 7.17–7.19 | P&L, trial balance and balance sheet update automatically | ✅ | Browser §14.1–14.6 measures the statements before and after a posting |
| 7.20–7.22 | No manual re-posting; no duplicate lines; a retry does not double up | ✅ | §13.3; the voucher carries a client key so a double submit posts once |

## Section 8 — Controls, currency and output

| # | Requirement | Status | Where | Evidence |
|---|---|---|---|---|
| 8.1–8.3 | MAD, USD, AED | ✅ | Everywhere money is entered | `SUPPORTED_CURRENCIES`; Dubai keeps AED, Morocco MAD, both hold USD |
| 8.4–8.7 | User-entered rate; original currency, amount and converted value all kept | ✅ | Every money form | §13.4/13.5: MAD 20,000 at 10 stays MAD 20,000 and USD 2,000 |
| 8.8 | A new rate does not rewrite history | ✅ | — | §13.6: a rate posted for September leaves June's entries alone |
| 8.9–8.11 | Debit and credit lines with validation | ✅ | Accounting → Journal Voucher | Balance shown live; unbalanced refused |
| 8.12 | Transaction date stored | ✅ | — | §8.12–8.15 test |
| 8.13 | Reference stored | 🟡 | — | The entry carries its own number, the source document it came from, and a narration; a dedicated free-text reference field is built but not shipped — it needs a column added to the live `journal_entries` table |
| 8.14–8.15 | Narration and user audit trail | ✅ | Journal report, Audit Trail | Live: 237 audit rows across create, post, correct. Sign-ins are recorded against the person rather than a company, so no company's access view can hide one |
| 8.16–8.17 | Unbalanced refused; a failed posting leaves no partial accounting | ✅ | — | §13.1/13.2 |
| 8.18–8.22 | Correction and reversal by authorised users, history retained and auditable | ✅ | Correct / delete on each document | Live shows two correction chains on invoices — post, deletion, repost — with every step still readable |
| 8.23–8.28 | Filters: date, party, warehouse, shipment, lot, currency | ✅ | Reports and lists | Browser §14.15–14.17 |
| 8.29 | Excel export on the major reports | ✅ | Export button | Ageing (summary and detail), balances, sales-by, stock movement and shipment cost were added for this checklist; `report-centre` downloads ten reports and checks the company name is on each file |
| 8.30 | PDF export | ✅ | "Print / PDF" | The print stylesheet through the browser's own Save as PDF |
| 8.31–8.33 | Company name, period, generation date in the file | ✅ | — | Written into every workbook's title block |
| 8.34–8.35 | The file carries the filtered data and the same totals | ✅ | — | Browser §14.18–14.20 compares the file's total income with the screen's |

## Section 9 — Required management reports

| # | Report | Status | Where |
|---|---|---|---|
| 9.1 | Shipment/lot profitability | ✅ | `/profitability`, `?view=statement` |
| 9.2 | Shipment/lot costing | ✅ | `/reports/shipment-cost` |
| 9.3 | Stock by lot | ✅ | `/inventory/batches` |
| 9.4 | Stock by product | ✅ | `/inventory`, `/reports/inventory-valuation?view=summary` |
| 9.5 | Stock by warehouse | ✅ | `/inventory`, `/reports/inventory-valuation` |
| 9.6 | Daily stock movement | ✅ | `/reports/stock-movement` |
| 9.7 | Closing stock | ✅ | Valuation summary and the movement report's closing column |
| 9.8–9.9 | Customer receivables and ageing | ✅ | `/finance/receivables`, `/reports/ageing` |
| 9.10–9.11 | Supplier payables and ageing | ✅ | `/finance/payables`, `/reports/ageing?side=payables` |
| 9.12–9.13 | Cash and bank summaries | ✅ | `/reports/financial-position`, `/reports/cash-book` |
| 9.14 | Petty cash summary | ⚪ | Supported; no petty cash account configured for Morocco |
| 9.15–9.17 | Direct and general expense reports, kept apart | ✅ | `/reports/expenses` |
| 9.18–9.20 | Sales, purchases, gross margin | ✅ | `/reports/sales`, `/reports/purchases`, `/reports/sales-by`, `/reports/cogs` |
| 9.21–9.23 | Company P&L, trial balance, balance sheet | ✅ | `/reports/profit-loss`, `/reports/trial-balance`, `/reports/balance-sheet` |

## Section 10 — The accounting principle

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 10.1–10.3 | The official statements represent the whole Morocco entity | ✅ | All three are company-wide; no shipment filter is applied to them |
| 10.4–10.6 | Shipment P&L and costing are a management view, not the statements | ✅ | Separate screens; the overhead share is labelled a management figure and writes no journal line |
| 10.7 | Shipment figures reconcile to the company's transactions | ✅ | Live: revenue and COGS match to the cent |
| 10.8 | Direct costs reconcile | ✅ | Live: 2,861.30 capitalised, equal to the posted expenses behind it |
| 10.9 | Shipment sales reconcile | ✅ | 292,010.90 both ways |
| 10.10 | Shipment stock reconciles to company inventory | ✅ | 218,517.02 both ways |

## Section 11 — Terminology

⚪ Definitions, not requirements. They were used as written: landed cost is
purchase plus capitalised direct costs; closing stock value is what remains at
that landed cost; gross profit is sales less the landed cost of what sold.

## Section 12 — Critical reconciliation tests

Every one of these runs in `tests/integration/pdf-compliance.test.ts` and was
also checked against the live books.

| # | Test | Status |
|---|---|---|
| 12.1 | Total debit = total credit | ✅ |
| 12.2 | Assets = liabilities + equity | ✅ |
| 12.3 | Receivables report = customer ledger and AR control | ✅ |
| 12.4 | Payables report = supplier ledger and AP control | ✅ |
| 12.5 | Cash summary = cash ledger | ✅ |
| 12.6 | Bank summary = bank ledger | ✅ |
| 12.7 | Inventory quantity agrees with the movement records | ✅ |
| 12.8 | Inventory value agrees with the accounting value | ✅ |
| 12.9 | Shipment direct expense agrees with the source vouchers | ✅ |
| 12.10 | General expense report agrees with the overhead ledger | ✅ |
| 12.11 | Purchased quantity agrees with the purchase and receipt records | ✅ |
| 12.12 | Sales quantity and value agree with the sales records | ✅ |
| 12.13 | Remaining quantity agrees with actual stock | ✅ |
| 12.14 | Profitability uses the linked transactions | ✅ |
| 12.15 | Company P&L uses posted records | ✅ |
| 12.16 | No fake or hardcoded values | ✅ |

## Section 13 — Negative and error testing

| # | Test | Status | Evidence |
|---|---|---|---|
| 13.1 | Unbalanced journal refused | ✅ | Throws; entry count unchanged |
| 13.2 | No partial journal left behind | ✅ | Same test, inside one transaction |
| 13.3 | Duplicate save/post creates nothing | ✅ | Second post refused, journal line count unchanged |
| 13.4–13.5 | USD and MAD keep their original values | ✅ | Amount, currency and rate all unchanged |
| 13.6 | A later FX rate does not alter history | ✅ | A September rate leaves June alone |
| 13.7 | A general expense saves with no shipment | ✅ | Saved and posted with `shipmentId` null |
| 13.8 | A capitalised shipment cost without a shipment is refused | ✅ | Throws at creation |
| 13.9 | The optional allocation does not duplicate the expense | ✅ | Shares sum to the expense on all four bases |
| 13.10 | A report with no transactions shows nothing, not fake values | ✅ | The empty company returns zeros and empty lists |

## Section 14 — Browser verification

All of these run in `tests/e2e/pdf-compliance.spec.ts` against a real browser.

| # | Step | Status | Result |
|---|---|---|---|
| 14.1–14.2 | Open shipment costing, enter a direct expense | ✅ | MAD 5,000 clearing charge posted from the voucher |
| 14.3 | Shipment profitability changes | ✅ | Landed cost +500.00 USD, direct expenses +500.00 USD |
| 14.4 | Company accounts also update | ✅ | Booked once — cash out, cost in |
| 14.5–14.6 | Enter an overhead, see it on the company P&L | ✅ | Total expenses +900.00 USD |
| 14.7 | It does not attach to a shipment | ✅ | No shipment's overhead share moved |
| 14.8 | The optional allocation | ✅ | Allocated, then withdrawn; company expenses unchanged throughout |
| 14.9–14.10 | P&L with a custom date range | ✅ | Year, single day, quarterly columns, previous-year comparison |
| 14.11–14.12 | Trial balance, debit = credit | ✅ | 1,540,124.00 on both sides in the test book |
| 14.13–14.14 | Balance sheet, assets = liabilities + equity | ✅ | 51,373.95 both sides; a pre-trading date shows nothing |
| 14.15–14.17 | Currency, shipment and warehouse filters | ✅ | 12 rows → 7 in USD, then narrowed by shipment and warehouse |
| 14.18–14.20 | Excel and PDF exports, totals compared | ✅ | The file's total income matches the screen exactly |

---

## Totals

| | Count |
|---|---|
| Total checklist items | 320 |
| ✅ Built and tested | 317 |
| 🟡 Built, could be better | 1 |
| 🟠 Partly built | 0 |
| ❌ Missing | 0 |
| 🐛 Built but faulty | 0 |
| ⚪ Not applicable | 2 |

**🟡 8.13 — a dedicated Reference field on the journal voucher.** Today an
entry carries its own number, the document it was posted from, a narration and
a per-line narration, which is what the reports display. A free-text reference
field has been written — form field, validation, posting, journal report column
and general-ledger column — but it needs a nullable `reference` column added to
the live `journal_entries` table before it can be deployed, because shipping
the code against a database without the column would break the Journal and
General Ledger pages. The change is additive and touches no existing row.

**⚪ 7.7 and 9.14 — petty cash.** Petty cash exists as its own account type and
would appear in the cash summary, the cash book and the balance sheet like any
other drawer. No petty cash account is configured for Morocco, so there is
nothing to report on.

## Where the evidence lives

| Evidence | File |
|---|---|
| Reconciliations and negative tests | `tests/integration/pdf-compliance.test.ts` |
| Balance sheet heads | `tests/integration/balance-sheet-heads.test.ts` |
| Reporting views reconcile | `tests/integration/reporting-views.test.ts` |
| Overhead allocation | `tests/integration/overhead-allocation.test.ts` |
| Posting invariants | `tests/integration/accounting-invariants.test.ts` |
| Multi-container orders | `tests/integration/order-shipments.test.ts` |
| Section 14 in the browser | `tests/e2e/pdf-compliance.spec.ts` |
| Every report opens, customize and exports | `tests/e2e/report-centre.spec.ts` |
| The client's own workflow in the browser | `tests/e2e/client-scenario.spec.ts` |

Run them with `npm test` (services) and `npm run e2e` (browser). The browser
suite starts its own server against `TEST_DATABASE_URL` and never touches the
live books.
