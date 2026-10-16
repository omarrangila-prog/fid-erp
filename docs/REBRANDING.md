# Rebranding the product

There are two brands in the system, and they are changed in two different places.

| Brand | What it is | Where it is set |
|---|---|---|
| **Product brand** | The name of the software itself: sign-in page, browser tab, menu, shared-link pages. | Environment variables (below). One per deployment. |
| **Company brand** | A customer's own identity: name, trading name, logo, address, registration and tax numbers. It is printed on *that company's* invoices, statements and reports. | **Settings → Company profile**, per company, by the customer's own administrator. |

A customer never sees the product brand on their documents, and the product brand is
never taken from a customer record.

## Changing the product brand

No source file is edited. Set these in the deployment's environment (`.env`, or the host's
environment settings) and restart:

| Variable | Default | Used for |
|---|---|---|
| `PRODUCT_NAME` | `PRODUCT_NAME` | Everywhere the product is named. The placeholder is deliberately obvious. |
| `PRODUCT_SHORT_NAME` | initials of the name | The mark in the logo tile (2–4 letters). |
| `PRODUCT_TAGLINE` | `Import · Export · Inventory · Accounting` | Line under the name. |
| `PRODUCT_DESCRIPTION` | generic description | Page meta description and the sign-in blurb. |
| `PRODUCT_LOGIN_HEADLINE` | `From purchase order to profit, in one place.` | Large sentence on the sign-in page. |
| `PRODUCT_LOGIN_FOOTER` | empty | Small print on the sign-in page. |
| `PRODUCT_LOGO` | `/brand/logo.svg` | Path of the logo file under `public/`. |
| `PRODUCT_ICON` | `/brand/icon.svg` | Path of the square icon (favicon, app tile). |
| `PRODUCT_SUPPORT_EMAIL` | empty | Where "contact support" goes. |

The code that reads them is `src/lib/brand.ts` — the only place the product is named.
Client components get it through `useBrand()`; server components call `getBrand()`.

To use a real logo, put the file in `public/brand/` (SVG or PNG) and point `PRODUCT_LOGO` /
`PRODUCT_ICON` at it. The shipped `logo.svg` and `icon.svg` are placeholders that read
`PRODUCT_LOGO` / `PRODUCT_ICON`.

Colours: the palette is defined once as design tokens in `src/app/globals.css`
(`--color-forest-*`, `--color-gold-*`, `--color-paper`, `--color-ink`). Change the token
values and every screen follows; no component hard-codes a brand colour.

## What the FID deployment sets

FID Trading keeps its own look by setting the variables above in *its* environment
(`PRODUCT_NAME="FID Trading"`, `PRODUCT_SHORT_NAME="FID"`, …). They are listed in
`.env.example`. A deployment that sets none of them shows the neutral placeholder — so a new
deployment can never accidentally show another customer's name.

## Checklist when the real name arrives

1. Set `PRODUCT_NAME`, `PRODUCT_SHORT_NAME`, `PRODUCT_TAGLINE` in the environment.
2. Drop the logo and icon into `public/brand/` and set `PRODUCT_LOGO`, `PRODUCT_ICON`.
3. Adjust the colour tokens in `globals.css` if the palette changes.
4. Restart. Nothing else needs editing.
