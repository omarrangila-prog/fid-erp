# Productization map (brief §61) — audit of 16 Oct 2026

Written before any refactor. Everything below was measured on `main` @ `3fefff6`
(branch `productize/phase-0-baseline`). Nothing in the product has been changed yet.

## 1. What the base product already is

| Fact | Evidence |
|---|---|
| Already **multi-company**: `Company` + `UserCompany` + `/select-company` + `Session.activeCompany` | schema.prisma:246, `src/app/select-company`, `switchActiveCompany` |
| 62 models; **41 carry `companyId`**. The other 21 are either global (`User`, `Role`, `Permission`, `RolePermission`, `UserRole`, `Session`) or child rows scoped through their parent (`*Line`, `*History`, `ReceiptAllocation`, `PaymentAllocation`, `JournalLine`, `ExpenseBatchShare`) | script over schema |
| Company already holds: `code, name, legalName, country, localCurrency, baseCurrency(default USD), timezone, address, docPrefix, taxEnabled, taxLabel, taxRegistrationNumber, taxPeriodMonths` | schema.prisma:246 |
| Per-company `ApplicationSetting(companyId?, key)` key/value store; `companyId` is nullable (global rows) | schema.prisma:2056 |
| Granular permission catalogue (`resource.action`), roles, server guards, Argon2id, login throttle, PIN throttle, opaque hashed sessions | `constants.ts`, `src/lib/auth/*` |
| 62 integration + 26 unit + 48 e2e test files; reconciliation checks live in-app | `tests/`, `services/reconciliation.ts`, `consistency.ts` |
| Two live tenants: FID Dubai (AED) and FID Morocco (MAD), group currency USD, on Supabase (Tokyo) | `.env`, `docs/HANDOVER.md` |

**Consequence:** brief §5 applies. Tenancy exists — **extend `Company`, do not introduce a second tenancy system.**
Hierarchy becomes `Platform → Organization (new, thin, owns users + plan) → Company → Warehouse`. Branch is deferred (no current need).

## 2. Hardcoding classified (brief §1)

~50 source files mention Morocco / MAD / FID / Dubai / AED / TVA / dirham. By class:

| Class | Where | Action |
|---|---|---|
| **D. Accidental hardcoding** | `layout.tsx` title/description; `login/page.tsx` (FID mark, both entity names, "Dubai and Morocco"); `topbar.tsx` "FID" mark; PDF/Excel headers in `api/export/[report]`; `reports/page.tsx`; share pages `src/app/s/[token]` | → central `brand.ts` (product) + company branding (documents) |
| **D. Currency lists** | `money.ts:42 SUPPORTED_CURRENCIES = USD, AED, MAD`; `money.ts:38` decimals map; `company-currencies.ts` (`local==='MAD' ? [MAD,USD] : [USD,AED,MAD]`); `CURRENCY_NAMES` (4 entries) | → `Company.salesCurrencies / purchaseCurrencies` + ISO currency table |
| **D. Country labels** | `tax.ts`, `journal-form.tsx` (14), `sale-form.tsx`, `receipt-form.tsx`, `loading-sheet.tsx` mention TVA/MAD/Dubai in copy | → read `company.taxLabel`, `localCurrency` |
| **B. Tenant config living in code** | `seed/core.ts` (26 hits): creates both FID companies, prefixes `FID-DXB`, `FID-MA` | → seed becomes platform-only; FID tenants move to a `tenants/fid.ts` config file used by `db:init` only |
| **A. Business data in repo** | `scripts/correct-radouan-links.ts`, `post-ridwan-august-loan.ts`, `rename-agent-name.ts`, `remove-customer-and-history.ts`, `*-rv-000020.ts`, `repair-invoice-1-*`; tests `ridwan-counterparty`, `morocco-*` | → move to `scripts/fid-ops/` (one-off, not shipped in the product build); keep `morocco-*` tests as the **FID regression pack** |
| **C. Genuine logic that merely mentions a country** | `receipt.ts`, `import-tax-correction.ts`, `shipment-fx.ts`, `cash-transfer.ts` — comments/examples, not branches | leave; reword comments only if touched |
| **Domain model** | `CoffeeItem` (+ enums `CoffeeType`, `CoffeeProcess`, `PackagingType`), `bagWeightKg`; 157 files mention "coffee", ~660 sites assume KG | see §3 |

## 3. The three structural risks (these decide the plan)

### R1 — USD is the accounting pivot, not a label
66 `*Usd`/`rateToUsd`/`rateLocalPerUsd` columns, literal `'USD'` in **125 files**, `Company.baseCurrency` read in only **7**.
The posting engine enforces "USD balanced exactly; local drift absorbed on translated lines" (PROGRESS.md).
A EUR-base or AED-base company (QA matrix B/C) cannot work until this is resolved.

**Recommended approach (lowest regression risk):** keep the physical columns (`amountUsd` etc.) and treat them as
**"reporting/group currency"** = `Company.baseCurrency`. No data migration, FID history byte-identical.
Work = (a) replace the 125 literal `'USD'` sites with `company.baseCurrency` after classifying each, (b) rename labels in UI/PDF,
(c) a new regression test per matrix company. A physical rename is rejected: touching 66 columns on a live ledger buys nothing a label doesn't.

### R2 — Item master is coffee-shaped and KG-shaped
`CoffeeItem` has coffee-only required-ish fields (`coffeeType`, `process`, `packagingType`, `originCountry` mandatory, `bagWeightKg`).
**Approach:** keep the table name (`@@map` unchanged, no data move). Add `uom`, `purchaseUom`, `salesUom`, `hsCode`, `brand`, `taxCategory`,
`attributes Json`; relax coffee enums to nullable/“OTHER”; promote coffee fields into a **“Coffee” attribute template** for the FID tenants
(values copied, original columns left in place and still written for FID, so nothing is lost). Rename to `Item` at TypeScript level only.
Costing/quantity stays stored in the base unit (KG for FID); each item gets a conversion factor to its UOM — display/entry convert, ledgers don't.

### R3 — Isolation holds by convention, not by the database
Isolation is enforced in application queries (`where companyId`). No RLS. Child rows rely on parent joins. `ApplicationSetting.companyId` nullable.
`ownShipmentId`-style guards exist only where someone remembered them. Selling this means the brief’s §60 proof must be **tests, not inspection**:
- a generated test that, for every route/action/export/search/share-token, runs as tenant A against tenant B’s ids and expects not-found;
- a schema test that fails if a new model lacks `companyId` (or a documented parent link);
- evaluate Postgres RLS as defence-in-depth **after** the Prisma driver-adapter session variable plumbing is proven (Prisma 7 + pg adapter; not assumed).

## 4. Required schema changes (all additive; no destructive migrations)

1. `Organization` (id, name, plan, status) + `Company.organizationId` (backfill: one org per existing company group, FID = one org with 2 companies).
2. `Company`: `logoAttachmentId`, `tradingName`, `phone`, `email`, `website`, `companyRegistration`, `brand` (json tokens), `dateFormat`, `numberFormat`, `locale`,
   `salesCurrencies[]`, `defaultSalesCurrency`, `purchaseCurrencies[]`, `industryTemplate`, `businessType`, `fxPolicy` (actual-FX handling), `terminology` json.
3. `CompanyFeature(companyId, feature, enabled)` + `Plan`/`PlanEntitlement` → one `can(company, FEATURE)` function (§51–52). **Existing FID companies get every feature ON** so behavior is unchanged.
4. `Item` additions per R2; `UnitOfMeasure` enum → table (`Uom`: code, name, kind, baseFactor) with the 11 existing enum values seeded.
5. `Currency` reference table (ISO code, name, decimals) replacing `CURRENCY_NAMES` and the decimals map.
6. Logistics: `Shipment.logisticsType` (CONTAINER default for existing rows); container requirement becomes conditional.
7. Audit: confirm `createdBy/updatedBy` coverage per table; add where missing.
8. Auth: `Organization.authPolicy` (PASSWORD default, PIN optional). Existing FID keeps its PIN login.
9. Platform admin: `PlatformUser` separate from tenant `User`; every cross-tenant read writes an audit row and is blocked from financial tables by default (§53).

## 5. Migration order (what depends on what)

| Phase | Content | Why this order |
|---|---|---|
| 0 | **Branch, baseline green, backup restore proven, FID golden snapshot** | nothing else is verifiable without it |
| 1 | FID golden-master: record trial balance, P&L, balance sheet, stock value, AR/AP per company from a **restored copy** of prod; assert identical after every phase | §1/§64 |
| 2 | `brand.ts` + company branding columns + documents read company identity | no accounting risk, immediate visible win |
| 3 | Remove D-class hardcoding (login, titles, exports, scripts → `fid-ops/`) | mechanical |
| 4 | Currency table, base-currency generalisation (R1), UOM table, tax terminology | highest risk; needs the golden master |
| 5 | Isolation test generator + schema guard + platform-admin boundary | before any second real customer |
| 6 | Feature/entitlement layer, templates, module toggles, terminology | needs 4 |
| 7 | Onboarding wizard + Excel/CSV import | needs 4 and 6 |
| 8 | Demo tenant (own database, fictional data, 4 industry presets) | needs 6 and 7 |
| 9 | QA matrix A–D, security review, performance (indexes, N+1, pagination) | |
| 10 | Staging → demo deploy; docs | |

## 6. Regression risks and guards

- **Historical accounting:** golden-master report hashes before/after each phase; `reconciliation.ts` must stay 20/20 green per company.
- **Live database:** all schema work is `prisma migrate` additive, applied to a **restored copy first**; never against the Supabase production URL from this machine without an explicit go-ahead and a fresh `pg_dump` (`backups/` has the pattern).
- **Test DB is shared and TRUNCATEd.** On 16 Oct another Claude session was running the full suite against the same `fid_trading_test` database while this audit ran. Concurrent runs corrupt each other. Rule from here: one runner at a time, or give each runner its own database (`fid_trading_test_<name>`).
- **Existing dirty-tree discipline:** `main` was clean at audit start; work stays on `productize/*` branches, merged only after FID regression passes.
- **Over-engineering (§63):** no rewrite of accounting, inventory, landed cost, sales, purchasing — only parameterisation.

## 7. Decisions needed from the owner (blocking Phase 4+, not Phase 0–3)

1. **Reporting-currency approach (R1):** keep `*Usd` columns as “reporting currency” (recommended) vs physical rename.
2. **Where the demo lives:** a new, separate database/project (recommended) — never a tenant inside the FID production database.
3. **Product name** for `PRODUCT_NAME` (placeholder until supplied).
4. **Repo strategy:** same repo, `productize/*` branches, FID deploys from `main` only after golden-master passes (recommended) vs a fork.
