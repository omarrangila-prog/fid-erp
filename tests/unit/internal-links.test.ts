import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import path from 'node:path';

/**
 * Every internal link points at a route that exists.
 *
 * A dashboard figure linked to /reports/inventory-valuation, which was never
 * built. Nobody noticed because the figure rendered perfectly — Next prefetched
 * the 404 quietly, and it only became visible when somebody clicked it and got
 * "Page not found". The browser console had been saying so all along.
 *
 * This is a whole class of fault: a link written for a page that was renamed,
 * moved, or planned and never built. It is invisible in review and obvious to
 * whoever clicks it.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of globSync('**/*.{ts,tsx}', { cwd: dir })) {
    out.push(path.join(dir, entry));
  }
  return out;
}

/** Every route the application actually serves. */
function servedRoutes(): string[] {
  const routes: string[] = [];
  for (const file of globSync('**/{page,route}.{ts,tsx}', { cwd: 'src/app' })) {
    const dir = path.dirname(file);
    const cleaned = dir === '.' ? '' : `/${dir}`;
    routes.push(cleaned.replace('/(app)', '').replace('/(auth)', '') || '/');
  }
  return routes;
}

function matches(href: string, routes: string[]): boolean {
  const target = href.split('?')[0].split('#')[0].replace(/\/$/, '') || '/';
  if (routes.includes(target)) return true;

  return routes.some((route) => {
    const pattern =
      '^' +
      route
        .replace(/\[\.\.\.[^\]]+\]/g, '.+')
        .replace(/\[[^\]]+\]/g, '[^/]+') +
      '$';
    return new RegExp(pattern).test(target);
  });
}

const LINK_PATTERNS = [
  /href=(?:"|'|\{")(\/[a-zA-Z0-9/_?=&.-]*)/g,
  /href:\s*[`'"](\/[a-zA-Z0-9/_?=&.-]*)/g,
  /\.push\(\s*[`'"](\/[a-zA-Z0-9/_?=&.-]*)/g,
  /redirect\(\s*[`'"](\/[a-zA-Z0-9/_?=&.-]*)/g,
];

describe('internal links', () => {
  it('all point at a route that exists', () => {
    const routes = servedRoutes();
    expect(routes.length, 'the route scan found nothing, so this test proves nothing').toBeGreaterThan(20);

    const broken: string[] = [];

    for (const file of walk('src')) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of LINK_PATTERNS) {
        for (const match of text.matchAll(pattern)) {
          const href = match[1];
          // Interpolated hrefs and API routes are checked elsewhere.
          if (href.startsWith('/api/') || href.includes('${')) continue;
          if (!matches(href, routes)) broken.push(`${href}  ←  ${file}`);
        }
      }
    }

    expect([...new Set(broken)], `dead links:\n${[...new Set(broken)].join('\n')}`).toEqual([]);
  });
});

/**
 * Every page can be got to.
 *
 * The sidebar was trimmed from fifty-two entries to forty-one, and that is
 * exactly the change that strands a screen: it stays built, keeps working, and
 * has no route to it any more. Nobody notices, because nobody can get there to
 * notice.
 *
 * So a page must be reachable from the sidebar, from the Reports index, or
 * from a link on another page. Detail pages and the sub-pages of a screen —
 * /purchases/[id], /sales/new — are reached from their own list and are not
 * checked here; this is about top-level screens with nowhere to be found.
 */
describe('nothing is stranded', () => {
  const sources = walk('src');
  const allText = sources.map((file) => readFileSync(file, 'utf8')).join('\n');

  /** Top-level screens: one segment, no parameters. */
  const topLevel = servedRoutes().filter(
    (route) =>
      !route.startsWith('/api') &&
      !route.includes('[') &&
      route.split('/').filter(Boolean).length >= 1 &&
      !['/login', '/select-company', '/unauthorized', '/dashboard'].includes(route),
  );

  const linked = (route: string) =>
    new RegExp(`['\`"]${route.replace(/\//g, '\\/')}['\`"?]`).test(allText);

  it.each(topLevel)('%s is linked from somewhere', (route) => {
    if (linked(route)) return;

    /*
     * A sub-page is reached from its own list, and often by a href built at
     * runtime — `${basePath}/new` — which no amount of searching for the
     * literal string will find. /purchases/debit-notes/new is exactly that,
     * and the first version of this test reported it as stranded when it is
     * one click from the debit notes list.
     *
     * So for those, the parent has to be reachable instead. That still catches
     * the thing worth catching: a whole screen with no way in.
     */
    const conventional = /\/(new|edit|print)$/;
    if (conventional.test(route)) {
      const parent = route.replace(conventional, '');
      expect(linked(parent), `${route}: neither it nor ${parent} is linked from anywhere`).toBe(true);
      return;
    }

    expect(false, `${route} has no link pointing at it`).toBe(true);
  });
});
