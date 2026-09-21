import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS, SHIPMENT_STATUS_META } from '@/lib/constants';
import { traceReference } from '@/lib/services/trace';
import { shortDocumentNumber } from '@/lib/short-number';
import { transferNumberLabel } from '@/lib/transfer-number';
import { formatDate, formatMoney, formatQuantityKg } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/feedback';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = { title: 'Trace a reference' };
export const dynamic = 'force-dynamic';

function Section({ title, description, children, empty }: { title: string; description?: string; children: React.ReactNode; empty: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="overflow-x-auto">{empty ? <p className="text-xs text-ink-subtle">Nothing yet.</p> : children}</CardContent>
    </Card>
  );
}

const th = 'py-1.5 pr-3 text-left text-xs font-medium uppercase tracking-wide text-ink-muted';
const td = 'py-1.5 pr-3 text-sm';

/**
 * ICUL/FID/001 from purchase to sale on one page: the order, its containers,
 * the lots and batches they became, where they were received, where the
 * coffee is now, every transfer, and every customer who bought it.
 */
export default async function TracePage({ searchParams }: { searchParams: Promise<{ ref?: string }> }) {
  const { ref } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.INVENTORY_VIEW);
  const result = ref ? await traceReference(user.activeCompany.id, ref) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trace a reference"
        description="Follow an ICUL/FID order from purchase, through containers, batches, warehouses and transfers, to the customers who bought it."
        breadcrumbs={[{ label: 'Inventory', href: '/inventory' }, { label: 'Trace' }]}
      />

      <form className="flex max-w-xl gap-2" action="/trace">
        <Input name="ref" defaultValue={ref ?? ''} placeholder="ICUL/FID/001" aria-label="ICUL/FID reference" />
        <Button type="submit">Trace</Button>
      </form>

      {!ref ? null : !result || result.orders.length === 0 ? (
        <EmptyState title={`No order matches “${ref}”`} description="Type all or part of the ICUL/FID reference on the purchase order." />
      ) : (
        result.orders.map((t) => (
          <div key={t.order.id} className="space-y-4">
            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-5">
                <div>
                  <Link href={`/purchases/${t.order.id}`} className="text-lg font-semibold text-forest-800 hover:text-gold-700">
                    {t.order.contractReference}
                  </Link>
                  <p className="text-sm text-ink-muted">
                    {t.order.vendor.vendorName} · {formatDate(t.order.contractDate)} · {t.shipments.length}{' '}
                    {t.shipments.length === 1 ? 'container' : 'containers'}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                  <span>Ordered <strong className="tnum">{formatQuantityKg(t.totals.orderedKg)}</strong></span>
                  <span>Received <strong className="tnum">{formatQuantityKg(t.totals.receivedKg)}</strong></span>
                  <span>Sold <strong className="tnum">{formatQuantityKg(t.totals.soldKg)}</strong></span>
                  <span>On hand <strong className="tnum">{formatQuantityKg(t.totals.onHandKg)}</strong></span>
                </div>
              </CardContent>
            </Card>

            <Section title="Containers, lots and batches" empty={t.batches.length === 0}>
              <table className="w-full min-w-[44rem]">
                <thead><tr><th className={th}>Container</th><th className={th}>Lot</th><th className={th}>Batch</th><th className={th}>Item</th><th className={`${th} text-right`}>Ordered</th><th className={`${th} text-right`}>Received</th><th className={`${th} text-right`}>Sold</th><th className={th}>Status</th></tr></thead>
                <tbody>
                  {t.batches.map((b) => {
                    const shipment = t.shipments.find((s) => s.id === b.shipmentId);
                    return (
                      <tr key={b.id} className="border-t border-line/60">
                        <td className={`${td} font-mono text-xs`}>{b.container?.containerNumber ?? '—'}</td>
                        <td className={td}>{b.lot?.lotNumber ?? '—'}</td>
                        <td className={td}><Link href={`/inventory/batches/${b.id}`} className="text-forest-800 hover:text-gold-700">{b.batchNumber}</Link></td>
                        <td className={td}>{b.item.itemName}</td>
                        <td className={`${td} tnum text-right`}>{formatQuantityKg(b.orderedQuantityKg)}</td>
                        <td className={`${td} tnum text-right`}>{formatQuantityKg(b.receivedQuantityKg)}</td>
                        <td className={`${td} tnum text-right`}>{formatQuantityKg(b.soldQuantityKg)}</td>
                        <td className={td}>{shipment ? <StatusBadge status={shipment.status} meta={SHIPMENT_STATUS_META} /> : '—'}{shipment?.etaDate ? <span className="ml-2 text-xs text-ink-subtle">ETA {formatDate(shipment.etaDate)}</span> : null}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Section>

            <Section title="Received into" empty={t.receipts.length === 0}>
              <table className="w-full min-w-[32rem]">
                <thead><tr><th className={th}>Date</th><th className={th}>Warehouse</th><th className={th}>Batch</th><th className={`${th} text-right`}>KG</th></tr></thead>
                <tbody>
                  {t.receipts.map((r, i) => (
                    <tr key={i} className="border-t border-line/60">
                      <td className={td}>{formatDate(r.goodsReceipt.receiptDate)}</td>
                      <td className={td}>{r.goodsReceipt.warehouse.name}</td>
                      <td className={td}>{r.batch.batchNumber}</td>
                      <td className={`${td} tnum text-right`}>{formatQuantityKg(r.quantityKg)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

            <Section title="Where it is now" empty={t.stock.length === 0}>
              <table className="w-full min-w-[32rem]">
                <thead><tr><th className={th}>Warehouse</th><th className={th}>Item</th><th className={th}>Batch</th><th className={`${th} text-right`}>On hand</th><th className={`${th} text-right`}>Available</th></tr></thead>
                <tbody>
                  {t.stock.map((s, i) => (
                    <tr key={i} className="border-t border-line/60">
                      <td className={td}>{s.warehouse.name}</td>
                      <td className={td}>{s.batch.item.itemName}</td>
                      <td className={td}>{s.batch.batchNumber}</td>
                      <td className={`${td} tnum text-right`}>{formatQuantityKg(s.onHandKg)}</td>
                      <td className={`${td} tnum text-right`}>{formatQuantityKg(s.availableKg)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

            <Section title="Warehouse transfers" empty={t.transfers.length === 0}>
              <table className="w-full min-w-[36rem]">
                <thead><tr><th className={th}>Transfer</th><th className={th}>Date</th><th className={th}>From → To</th><th className={th}>Batch</th><th className={`${th} text-right`}>KG</th></tr></thead>
                <tbody>
                  {t.transfers.map((x, i) => (
                    <tr key={i} className="border-t border-line/60">
                      <td className={td}><Link href={`/inventory/transfers/${x.stockTransfer.id}`} className="font-medium text-forest-800 hover:text-gold-700">{transferNumberLabel(x.stockTransfer.transferNumber)}</Link>{x.stockTransfer.status === 'REVERSED' ? <span className="ml-1 text-xs text-red-600">reversed</span> : null}</td>
                      <td className={td}>{formatDate(x.stockTransfer.transferDate)}</td>
                      <td className={td}>{x.stockTransfer.fromWarehouse.name} → {x.stockTransfer.toWarehouse.name}</td>
                      <td className={td}>{x.batch.batchNumber}</td>
                      <td className={`${td} tnum text-right`}>{formatQuantityKg(x.quantityKg)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

            <Section title="Sold to" description={t.customers.length > 0 ? t.customers.map((c) => c.customerName).join(', ') : undefined} empty={t.sales.length === 0}>
              <table className="w-full min-w-[44rem]">
                <thead><tr><th className={th}>Invoice</th><th className={th}>Date</th><th className={th}>Customer</th><th className={th}>Item</th><th className={th}>Batch</th><th className={th}>Warehouse</th><th className={`${th} text-right`}>KG</th><th className={`${th} text-right`}>Amount</th></tr></thead>
                <tbody>
                  {t.sales.map((s, i) => (
                    <tr key={i} className="border-t border-line/60">
                      <td className={td}><Link href={`/sales/${s.salesInvoice.id}`} className="font-medium text-forest-800 hover:text-gold-700">{shortDocumentNumber(s.salesInvoice.invoiceNumber)}</Link></td>
                      <td className={td}>{formatDate(s.salesInvoice.invoiceDate)}</td>
                      <td className={td}><Link href={`/ledgers/customers/${s.salesInvoice.customer.id}`} className="hover:underline">{s.salesInvoice.customer.customerName}</Link></td>
                      <td className={td}>{s.item.itemName}</td>
                      <td className={td}>{s.batch?.batchNumber ?? '—'}</td>
                      <td className={td}>{s.warehouse?.name ?? '—'}</td>
                      <td className={`${td} tnum text-right`}>{formatQuantityKg(s.quantityKg)}</td>
                      <td className={`${td} tnum text-right`}>{formatMoney(s.lineTotal, s.salesInvoice.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          </div>
        ))
      )}
    </div>
  );
}
