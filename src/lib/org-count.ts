import { prisma } from '@/lib/db';

let organizationCountMemo: { at: number; value: number } | null = null;

export async function organizationCount(): Promise<number> {
  const now = Date.now();
  if (organizationCountMemo && now - organizationCountMemo.at < 30_000) return organizationCountMemo.value;
  const value = await prisma.organization.count();
  organizationCountMemo = { at: now, value };
  return value;
}

/** Forget the remembered count — after creating or removing an organization. */
export function forgetOrganizationCount(): void {
  organizationCountMemo = null;
}

