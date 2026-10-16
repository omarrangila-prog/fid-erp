# Creating a customer (tenant)

A customer is an **Organization** with one or more **Companies**. Create it in the
platform console; do not insert rows by hand.

## In the console

1. Sign in as a platform operator (an address listed in `DEVELOPER_USERS`) and open `/platform`.
2. **New customer**: organization name, first company name, country, industry template, plan,
   and the owner's name and email.
3. The console creates the organization, the company with its chart of accounts, expense
   categories, tax codes (empty of rates) and ports, and the owner's sign-in with a
   **temporary password shown once**. The owner must change it at first sign-in.
4. Give the owner the sign-in address and that password.

The same operation is available in code: `createTenant()` in `src/lib/services/tenant.ts`.
Further companies for an existing customer: `addCompany()` (subject to the plan's company limit).

## What the owner does next

The owner lands in the **setup wizard** (`/onboarding`), ten skippable steps:

1. Company details · 2. Country & currency · 3. How you trade · 4. Your products (template, unit)
· 5. Warehouses · 6. Banks & cash · 7. Taxes · 8. Team · 9. Bring your data · 10. Start.

"Bring your data" accepts CSV/Excel for items, customers, suppliers, opening stock, chart of
accounts and opening balances. **Check file** runs the real import and rolls it back, listing
every row problem; **Import** commits. Templates: `/api/import-template/<kind>`.

## Plans and switches

`setOrganizationPlan()` changes the plan (STARTER / GROWTH / ENTERPRISE: user, company and
warehouse limits and feature entitlements). `setOrganizationStatus()` suspends or reinstates
a customer: a suspended organization's users are signed out. `resetOwnerPassword()` issues a
new temporary password. All three are audited and shown in the console.

## Checks after creating one

- Sign in as the owner: the dashboard redirects to the wizard.
- The letterhead on an invoice shows the *customer's* name, not the product's.
- Switch to another customer's owner: none of the first customer's records are reachable.
