import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Building2, ArrowRight } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { CompanyChoice } from '@/app/select-company/company-choice';

export const metadata: Metadata = { title: 'Choose a company' };

/**
 * Company selection.
 *
 * Staff belong to one company and never see this screen — they are routed
 * straight to their dashboard. An administrator with access to both companies
 * chooses which set of books to open, so it is never ambiguous which company a
 * transaction will be posted into.
 */
export default async function SelectCompanyPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.companies.length === 1) redirect('/dashboard');

  const summaries = await Promise.all(
    user.companies.map(async (company) => {
      const [shipments, customers, openInvoices] = await Promise.all([
        prisma.shipment.count({
          where: { companyId: company.id, purchaseContract: { status: 'POSTED' }, status: { notIn: ['CLOSED'] } },
        }),
        prisma.customer.count({ where: { companyId: company.id, status: 'ACTIVE' } }),
        prisma.salesInvoice.count({ where: { companyId: company.id, status: 'POSTED' } }),
      ]);
      return { ...company, shipments, customers, openInvoices };
    }),
  );

  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-forest-50 via-paper to-gold-50 px-5 py-12">
      <div className="w-full max-w-3xl space-y-8">
        <div className="space-y-2 text-center">
          <div className="mx-auto grid size-10 place-items-center rounded-lg bg-gold-500 text-sm font-bold text-forest-950">
            FID
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">
            Welcome back, {user.name.split(' ')[0]}
          </h1>
          <p className="text-sm text-ink-muted">Choose the company you want to work in.</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {summaries.map((company) => (
            <CompanyChoice key={company.id} company={company} />
          ))}
        </div>

        <p className="flex items-center justify-center gap-1.5 text-center text-xs text-ink-muted">
          <Building2 className="size-3.5" />
          You can switch companies at any time from the top bar.
          <ArrowRight className="size-3.5" />
        </p>
      </div>
    </main>
  );
}
