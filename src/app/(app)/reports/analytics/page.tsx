import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import {
  getCustomerProfitability, getProductProfitability, getBatchProfitability,
  getContainerProfitability, getShipmentProfitability,
} from '@/lib/services/profitability';
import { PageHeader } from '@/components/shared/page-header';
import { PrintButton } from '@/components/shared/print-button';
import { PrintHeader } from '@/components/shared/print-header';
import { AnalyticsClient, type Dimension, type Slice } from '@/app/(app)/reports/analytics/analytics-client';

export const metadata: Metadata = { title: 'Analysis' };
export const dynamic = 'force-dynamic';

type Breakdown = Awaited<ReturnType<typeof getCustomerProfitability>>;

/** Decimals are turned into plain numbers here so none crosses to the client. */
function toSlices(rows: Breakdown): Slice[] {
  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    sublabel: row.sublabel,
    quantityKg: Number(row.quantityKg),
    revenueUsd: Number(row.revenueUsd),
    cogsUsd: Number(row.cogsUsd),
    grossProfitUsd: Number(row.grossProfitUsd),
    marginPct: Number(row.grossMarginPct),
    profitPerKgUsd: Number(row.profitPerKgUsd),
  }));
}

export default async function AnalyticsPage() {
  const user = await requirePageAccess(PERMISSIONS.PROFITS_VIEW);
  const companyId = user.activeCompany.id;

  const [customers, products, batches, containers, shipments] = await Promise.all([
    getCustomerProfitability({ companyId }),
    getProductProfitability({ companyId }),
    getBatchProfitability({ companyId }),
    getContainerProfitability({ companyId }),
    getShipmentProfitability({ companyId }),
  ]);

  const dimensions: Dimension[] = [
    {
      id: 'customer',
      label: 'Customer',
      description: 'Who the margin actually comes from.',
      rows: toSlices(customers),
    },
    {
      id: 'coffee',
      label: 'Coffee',
      description: 'Which origins and grades earn their place.',
      rows: toSlices(products),
    },
    {
      id: 'batch',
      label: 'Batch',
      description: 'Margin on the exact parcel, at its own landed cost.',
      rows: toSlices(batches),
    },
    {
      id: 'container',
      label: 'Container',
      description: 'Useful where a container is the unit the trade thinks in.',
      rows: toSlices(containers),
    },
    {
      id: 'shipment',
      label: 'Shipment',
      description: 'The job, from purchase through freight to sale.',
      rows: shipments.map((row) => ({
        key: row.shipmentId,
        label: row.shipmentNumber,
        sublabel: `${row.itemName} · ${row.vendorName}`,
        quantityKg: Number(row.soldQuantityKg),
        revenueUsd: Number(row.salesRevenueUsd),
        cogsUsd: Number(row.allocatedLandedCostUsd),
        grossProfitUsd: Number(row.grossProfitUsd),
        marginPct: Number(row.grossMarginPct),
        profitPerKgUsd: Number(row.profitPerKgUsd),
      })),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analysis"
        description="One question — where the money comes from — asked along whichever axis matters today."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Analysis' }]}
        actions={<PrintButton />}
      />
      <PrintHeader
        title="Profitability analysis"
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
      />
      <AnalyticsClient
        dimensions={dimensions}
        companyCode={user.activeCompany.code}
        currencyNote="Amounts are in USD, converted at each voucher's own rate."
      />
    </div>
  );
}
