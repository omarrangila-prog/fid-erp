/**
 * The product's own identity — the one place it is named.
 *
 * This is the *platform* brand: the name on the sign-in page, the browser tab,
 * the sidebar and the sign-off of an e-mail. It is not a customer's brand: a
 * customer's documents (invoices, statements, reports) carry that company's own
 * name, address and logo from its Company record.
 *
 * Rebranding is configuration, not a code change. Set any of these in the
 * environment (see docs/REBRANDING.md) and restart:
 *
 *   PRODUCT_NAME          shown everywhere the product is named
 *   PRODUCT_SHORT_NAME    the 2–4 letter mark in the logo tile
 *   PRODUCT_TAGLINE       one line under the name
 *   PRODUCT_DESCRIPTION   meta description and sign-in blurb
 *   PRODUCT_LOGO          path of the logo under /public (default /brand/logo.svg)
 *   PRODUCT_ICON          path of the square icon under /public
 *   PRODUCT_SUPPORT_EMAIL where "contact support" goes
 *
 * Until a real name is chosen the placeholder `PRODUCT_NAME` is shown, on
 * purpose: it is impossible to mistake for a finished brand.
 */

function read(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export type Brand = {
  name: string;
  shortName: string;
  tagline: string;
  description: string;
  logo: string;
  icon: string;
  supportEmail: string;
};

export function getBrand(): Brand {
  const name = read('PRODUCT_NAME', 'PRODUCT_NAME');
  return {
    name,
    shortName: read('PRODUCT_SHORT_NAME', initials(name)),
    tagline: read('PRODUCT_TAGLINE', 'Import · Export · Inventory · Accounting'),
    description: read(
      'PRODUCT_DESCRIPTION',
      'Purchase orders, shipments, landed cost, stock, sales and full double-entry accounting for importers, exporters and trading companies.',
    ),
    logo: read('PRODUCT_LOGO', '/brand/logo.svg'),
    icon: read('PRODUCT_ICON', '/brand/icon.svg'),
    supportEmail: read('PRODUCT_SUPPORT_EMAIL', ''),
  };
}

/** "Global Trading Suite" -> "GTS"; a single word -> its first two letters. */
export function initials(name: string): string {
  const words = name.split(/[\s_\-·.]+/).filter(Boolean);
  if (words.length === 0) return 'ERP';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words
    .map((w) => w[0])
    .join('')
    .slice(0, 4)
    .toUpperCase();
}
