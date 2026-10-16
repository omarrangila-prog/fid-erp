# Deployment

## Requirements

Node 20+, PostgreSQL 14+, a host that runs `next start` (or a serverless target with
`DATABASE_POOL_MAX=1`), and HTTPS in front.

## Environment

Start from `.env.example`. Required: `DATABASE_URL`, `DIRECT_URL` (migrations; session pooler
or direct connection, never a transaction pooler), `SESSION_COOKIE_NAME`, `SESSION_TTL_HOURS`,
`INITIAL_ADMIN_*` for the first administrator, `DEVELOPER_USERS` for platform operators.

Product identity: `PRODUCT_NAME`, `PRODUCT_SHORT_NAME`, `PRODUCT_TAGLINE`, `PRODUCT_DESCRIPTION`,
`PRODUCT_LOGO`, `PRODUCT_ICON`, `PRODUCT_LOGIN_HEADLINE`, `PRODUCT_LOGIN_FOOTER`,
`PRODUCT_SUPPORT_EMAIL`. Unset, the AURQORA brand is shown. Sign-in: `PIN_LOGIN=on|off|auto`
(auto: PIN sign-in only while the deployment has one organization). Demo: `DEMO_MODE=1`.

> Next loads `.env` itself. To *blank* a variable for one run, set it to an empty string; an
> `unset` is refilled from the file.

## First deployment

```
npm ci
npx prisma migrate deploy      # additive migrations only
npm run db:init                # first administrator
npm run build && npm start
```

## Upgrading an existing deployment (including FID Trading)

1. **Back up** the database and keep the dump.
2. **Rehearse on a restored copy**: restore the dump to a scratch database, point
   `DATABASE_URL`/`DIRECT_URL` at it, run `npx prisma migrate deploy`, then
   `scripts/gm.sh` — it must print `GOLDEN MASTER: identical` (every balance, ledger, stock
   figure and statement unchanged).
3. Put the `PRODUCT_*` variables on the host **before** deploying (FID's: name, short name,
   tagline, description, login headline/footer, `PRODUCT_ICON=/brand/fid-icon.svg`,
   `PRODUCT_LOGO=/brand/fid-logo.svg`) or the host will show the AURQORA brand. Set
   `PIN_LOGIN=auto` to keep PIN sign-in for a single-organization deployment.
4. Only then migrate production, deploy, and sign in as an administrator to smoke-test.

## The demo environment

```
createdb fid_demo
ALLOW_DEMO_SEED=1 DATABASE_URL=…/fid_demo npx tsx scripts/demo-tenant.ts --reset
DEMO_MODE=1 DATABASE_URL=…/fid_demo PIN_LOGIN=off npm start
```

The seeder refuses any database that is not a demo database, and the demo never contains
customer data. Re-run with `--reset` to restore it.

## Backups and health

Backups are whole-database, so in a multi-tenant deployment they are platform-only
(`backupsAllowed`). The platform console shows each customer's usage and health; each
company's reconciliation report proves its books balance.
