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
