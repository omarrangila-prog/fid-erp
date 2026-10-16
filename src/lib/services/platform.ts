import { prisma } from '@/lib/db';
import { reconcile } from '@/lib/services/reconciliation';

/**
 * What the platform operator may see about a customer: how big it is and
 * whether it is healthy. Counts and yes/no — never a balance, a name from
 * their books or a document. Anything more is the customer's to show.
 */
export type TenantUsage = {
  organizationId: string;
  name: string;
  plan: string;
  status: string;
  createdAt: Date;
  companies: Array<{ id: string; code: string; name: string; country: string; localCurrency: string; template: string }>;
  users: number;
  activeUsers30d: number;
  lastLoginAt: Date | null;
  postedThisMonth: number;
  storageMb: number;
};

export async function listTenants(): Promise<TenantUsage[]> {
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const since = new Date(Date.now() - 30 * 86_400_000);
  const orgs = await prisma.organization.findMany({
    orderBy: { createdAt: 'desc' },
    include: { companies: { select: { id: true, code: true, name: true, country: true, localCurrency: true, industryTemplate: true } } },
  });
  const out: TenantUsage[] = [];
  for (const org of orgs) {
    const ids = org.companies.map((c) => c.id);
    const [users, active, last, posted, bytes] = await Promise.all([
      prisma.user.count({ where: { organizationId: org.id } }),
      prisma.user.count({ where: { organizationId: org.id, lastLoginAt: { gte: since } } }),
      prisma.user.aggregate({ where: { organizationId: org.id }, _max: { lastLoginAt: true } }),
      prisma.journalEntry.count({ where: { companyId: { in: ids }, createdAt: { gte: monthStart } } }),
      prisma.attachment.aggregate({ where: { companyId: { in: ids } }, _sum: { sizeBytes: true } }),
    ]);
    out.push({
      organizationId: org.id,
      name: org.name,
      plan: org.plan,
      status: org.status,
      createdAt: org.createdAt,
      companies: org.companies.map((c) => ({ id: c.id, code: c.code, name: c.name, country: c.country, localCurrency: c.localCurrency, template: c.industryTemplate })),
      users,
      activeUsers30d: active,
      lastLoginAt: last._max.lastLoginAt,
      postedThisMonth: posted,
      storageMb: Math.round(((bytes._sum.sizeBytes ?? 0) / 1024 / 1024) * 10) / 10,
    });
  }
  return out;
}

/** Pass/fail only: how many of the books' own consistency checks hold. */
export async function tenantHealth(organizationId: string): Promise<Array<{ code: string; passed: number; total: number }>> {
  const companies = await prisma.company.findMany({ where: { organizationId }, select: { id: true, code: true } });
  const result = [];
  for (const c of companies) {
    const r = await reconcile(c.id);
    result.push({ code: c.code, passed: r.checks.filter((x) => x.passed).length, total: r.checks.length });
  }
  return result;
}
