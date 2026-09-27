import { prisma } from '@/lib/db';
import { allNavItems } from '@/components/layout/nav-config';

/**
 * A role's own menu: the pages the owner picked for it, in the owner's order.
 *
 * Kept in the settings table under one key per role, for every company — a
 * role is the same job in Morocco and in Dubai. It is only the order of the
 * menu; what the role may open is still its permissions, checked on the
 * server by every page.
 */

const keyOf = (roleId: string) => `role_menu:${roleId}`;

function parse(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

export async function getRoleMenu(roleId: string): Promise<string[]> {
  const row = await prisma.applicationSetting.findFirst({ where: { companyId: null, key: keyOf(roleId) } });
  return parse(row?.value);
}

/** Every role's pages, the first role's first, each page once. */
export async function getMenuForRoles(roleIds: string[]): Promise<string[]> {
  if (roleIds.length === 0) return [];
  const rows = await prisma.applicationSetting.findMany({
    where: { companyId: null, key: { in: roleIds.map(keyOf) } },
  });
  const byKey = new Map(rows.map((r) => [r.key, parse(r.value)]));
  return [...new Set(roleIds.flatMap((id) => byKey.get(keyOf(id)) ?? []))];
}

/** Only pages the menu actually has, once each, in the order given. */
export function cleanRoleMenu(hrefs: string[]): string[] {
  const known = new Set(allNavItems().map((item) => item.href));
  return [...new Set(hrefs)].filter((href) => known.has(href));
}

export async function setRoleMenu(roleId: string, hrefs: string[]): Promise<string[]> {
  const clean = cleanRoleMenu(hrefs);
  const key = keyOf(roleId);
  const existing = await prisma.applicationSetting.findFirst({ where: { companyId: null, key } });
  if (existing) {
    await prisma.applicationSetting.update({ where: { id: existing.id }, data: { value: JSON.stringify(clean) } });
  } else {
    await prisma.applicationSetting.create({ data: { companyId: null, key, value: JSON.stringify(clean) } });
  }
  return clean;
}
