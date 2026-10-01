import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract, reversePurchaseContract } from '@/lib/services/purchase';
import { receiveContainers } from '@/lib/services/goods-receipt';
import { applyQuickUpdate, getContainerHistory, getOrderQuickUpdate } from '@/lib/services/quick-update';
import { getLoadingSheet } from '@/lib/services/loading-sheet';
import { summariseContainers } from '@/lib/container-summary';
import { containerStage } from '@/lib/container-stage';

/**
 * Quick Update: the daily container operations from the list.
 *
 * A three-container order and a two-container order. From Quick Update alone
 * the first two containers are marked loaded and the third left; each gets
 * its own ETA, the documents move, container 1 arrives and is received. The
 * order then reads 2 / 3 Loaded, 1 / 3 Arrived, 1 / 3 Received — counted from
 * the same shipment records the shipment page reads — and every change is in
 * the container's own history. Deleting a shipment is deleting its order, and
 * is refused once anything has been received.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let threeId: string;
let twoId: string;
let three: string[] = [];
let two: string[] = [];

async function order(reference: string, containers: string[]) {
  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-09-01'), vendorId: masters.vendor.id, currency: 'USD',
      rateToUsd: '1', rateLocalPerUsd: '9.6', freightAmount: '0', contractReference: reference,
      lines: containers.map((container, i) => ({
        itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '5.00', bagWeightKg: '60',
        containerNumber: container, lotNumber: `${reference}-L${i + 1}`, batchNumber: `${reference}-B${i + 1}`,
      })),
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  const shipments = await prisma.shipment.findMany({ where: { purchaseContractId: contract.id }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  return { id: contract.id, shipments: shipments.map((s) => s.id) };
}

async function summary(contractId: string) {
  const rows = await getLoadingSheet(companyId, { contractId });
  return summariseContainers(
    rows.map((r) => {
      const all = r.receivedKg.greaterThan(0) && r.receivedKg.greaterThanOrEqualTo(r.quantityKg.minus('0.001'));
      return {
        stage: containerStage(r.status, all),
        containers: Math.max(r.containers, 1),
        documentStatus: r.documentStatus,
        etaIso: r.etaDate ? r.etaDate.toISOString().slice(0, 10) : null,
        partlyReceived: r.receivedKg.greaterThan(0) && !all,
      };
    }),
  );
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  ({ id: threeId, shipments: three } = await order('ICUL/FID/QU/003', ['QUCU1000001', 'QUCU1000002', 'QUCU1000003']));
  ({ id: twoId, shipments: two } = await order('ICUL/FID/QU/002', ['QUCU2000001', 'QUCU2000002']));
}, 300_000);

describe('Quick Update', () => {
  it('shows every container on the order — three for one, two for the other', async () => {
    const a = await getOrderQuickUpdate(companyId, threeId);
    const b = await getOrderQuickUpdate(companyId, twoId);
    expect(a.containers.map((c) => c.containerNumbers[0])).toEqual(['QUCU1000001', 'QUCU1000002', 'QUCU1000003']);
    expect(b.containers.map((c) => c.containerNumbers[0])).toEqual(['QUCU2000001', 'QUCU2000002']);
    expect(a.containers.map((c) => c.shipmentOrdinal)).toEqual([1, 2, 3]);
    expect(a.shippingLines.length).toBeGreaterThan(0);
  }, 120_000);

  it('gives each container its own ETA, and keeps every change in its history', async () => {
    const dates = ['2026-10-12', '2026-10-15', '2026-10-17'];
    for (const [i, id] of three.entries()) {
      const [result] = await applyQuickUpdate({ companyId, userId: ctx.admin.id, contractId: threeId, shipmentIds: [id], change: { op: 'eta', etaDate: utcDate(dates[i]) } });
      expect(result.ok).toBe(true);
    }
    // And the first one changes again.
    await applyQuickUpdate({ companyId, userId: ctx.admin.id, contractId: threeId, shipmentIds: [three[0]], change: { op: 'eta', etaDate: utcDate('2026-10-14') } });

    const rows = await prisma.shipment.findMany({ where: { id: { in: three } }, select: { id: true, etaDate: true } });
    const eta = new Map(rows.map((r) => [r.id, r.etaDate?.toISOString().slice(0, 10)]));
    expect(three.map((id) => eta.get(id))).toEqual(['2026-10-14', '2026-10-15', '2026-10-17']);

    const history = (await getContainerHistory(companyId, three[0])).filter((h) => h.what === 'ETA');
    expect(history).toHaveLength(2);
    expect(history[0].from?.slice(0, 10)).toBe('2026-10-12');
    expect(history[0].to?.slice(0, 10)).toBe('2026-10-14');
    expect(history[0].by).toBe(ctx.admin.name);
    expect((await summary(threeId)).etaLabel).toBe('14–17 Oct 2026');
  }, 120_000);

  it('marks two of three loaded, reports the one it cannot, and leaves the third alone', async () => {
    const line = masters.shippingLine.id;
    const results = await applyQuickUpdate({
      companyId, userId: ctx.admin.id, contractId: threeId, shipmentIds: [three[0], three[1]],
      change: { op: 'loaded', loadingDate: utcDate('2026-09-20'), shippingLineId: line, bookingNumber: 'BK-QU-1' },
    });
    expect(results.every((r) => r.ok && !r.skipped)).toBe(true);
    const s = await summary(threeId);
    expect(s.loadingLabel).toBe('2 / 3 Loaded');
    expect(s.loaded).toBe(2);

    // Pressing it again is harmless: already loaded, said so, nothing changed.
    const again = await applyQuickUpdate({ companyId, userId: ctx.admin.id, contractId: threeId, shipmentIds: [three[0]], change: { op: 'loaded', loadingDate: utcDate('2026-09-21') } });
    expect(again[0]).toMatchObject({ ok: true, skipped: true });

    // The two-container order has no shipping line yet: the service says so, by container.
    const refused = await applyQuickUpdate({ companyId, userId: ctx.admin.id, contractId: twoId, shipmentIds: two, change: { op: 'loaded', loadingDate: utcDate('2026-09-20') } });
    expect(refused.every((r) => !r.ok)).toBe(true);
    expect(refused[0].message).toMatch(/estimated arrival|shipping line/i);

    // The status history says who loaded it.
    const history = (await getContainerHistory(companyId, three[0])).filter((h) => h.what === 'Status');
    expect(history.some((h) => h.to === 'LOADED')).toBe(true);
  }, 120_000);

  it('moves the documents, keeps a note on the same status, and counts them per container', async () => {
    const r1 = await applyQuickUpdate({ companyId, userId: ctx.admin.id, contractId: threeId, shipmentIds: [three[0], three[1]], change: { op: 'documents', toStatus: 'COMPLETED', notes: null } });
    expect(r1.every((r) => r.ok)).toBe(true);
    // The same status again with a note is a progress note, recorded.
    const r2 = await applyQuickUpdate({ companyId, userId: ctx.admin.id, contractId: threeId, shipmentIds: [three[2]], change: { op: 'documents', toStatus: 'DRAFT_PENDING', notes: 'Working with: Shipping line · Original B/L · waiting for release' } });
    expect(r2[0]).toMatchObject({ ok: true });
    expect(r2[0].skipped).toBeFalsy();
    // And with nothing to say, it is left alone.
    const r3 = await applyQuickUpdate({ companyId, userId: ctx.admin.id, contractId: threeId, shipmentIds: [three[2]], change: { op: 'documents', toStatus: 'DRAFT_PENDING', notes: null } });
    expect(r3[0]).toMatchObject({ ok: true, skipped: true });

    const s = await summary(threeId);
    expect(s.documentsLabel).toBe('2 Complete · 1 Pending');
    const rows = await getLoadingSheet(companyId, { contractId: threeId });
    const third = rows.find((r) => r.shipmentId === three[2])!;
    expect(third.documentNote?.notes).toMatch(/waiting for release/);
    expect(third.documentNote?.changedBy).toBe(ctx.admin.name);
  }, 120_000);

  it('container 1 arrives and is received: 1 / 3 Arrived, 1 / 3 Received — the shipment record says the same', async () => {
    const arrived = await applyQuickUpdate({ companyId, userId: ctx.admin.id, contractId: threeId, shipmentIds: [three[0]], change: { op: 'arrived', ataDate: utcDate('2026-10-14') } });
    expect(arrived[0]).toMatchObject({ ok: true });
    expect((await summary(threeId)).arrivalLabel).toBe('1 / 3 Arrived');
    expect((await summary(threeId)).arrivalState).toBe('PARTIALLY_ARRIVED');

    const batch = await prisma.batch.findFirstOrThrow({ where: { shipmentId: three[0], status: 'ACTIVE' } });
    await receiveContainers({
      companyId, purchaseContractId: threeId, receiptDate: utcDate('2026-10-15'), receivedById: ctx.admin.id,
      lines: [{ batchId: batch.id, quantityKg: '20000', containerNumber: 'QUCU1000001', warehouseId: masters.warehouse.id } as never],
    });
    const s = await summary(threeId);
    expect(s.receiptLabel).toBe('1 / 3 Received');
    expect(s.loadingLabel).toBe('2 / 3 Loaded');

    // The shipment page reads the shipment itself — the same answer.
    const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: three[0] }, select: { status: true, ataDate: true } });
    expect(shipment.status).toBe('ARRIVED');
    expect(shipment.ataDate?.toISOString().slice(0, 10)).toBe('2026-10-14');
    const history = await getContainerHistory(companyId, three[0]);
    expect(history.some((h) => h.what === 'Received' && /20000 KG/.test(h.to ?? ''))).toBe(true);
  }, 180_000);

  it('never touches another company’s or another order’s containers', async () => {
    await expect(
      applyQuickUpdate({ companyId: ctx.dubai.id, userId: ctx.admin.id, contractId: threeId, shipmentIds: [three[1]], change: { op: 'eta', etaDate: utcDate('2026-12-01') } }),
    ).rejects.toThrow(/not found/i);
    await expect(
      applyQuickUpdate({ companyId, userId: ctx.admin.id, contractId: twoId, shipmentIds: [three[1]], change: { op: 'eta', etaDate: utcDate('2026-12-01') } }),
    ).rejects.toThrow(/not found/i);
    await expect(getOrderQuickUpdate(ctx.dubai.id, threeId)).rejects.toThrow(/not found/i);
    await expect(getContainerHistory(ctx.dubai.id, three[0])).rejects.toThrow(/not found/i);
    const unchanged = await prisma.shipment.findUniqueOrThrow({ where: { id: three[1] }, select: { etaDate: true } });
    expect(unchanged.etaDate?.toISOString().slice(0, 10)).toBe('2026-10-15');
  }, 120_000);

  it('deleting a shipment deletes its order — allowed before anything is received, refused after', async () => {
    await expect(reversePurchaseContract({ id: threeId, companyId, userId: ctx.admin.id, reason: 'Entered twice' })).rejects.toThrow(/received/i);

    await reversePurchaseContract({ id: twoId, companyId, userId: ctx.admin.id, reason: 'Entered twice' });
    expect((await prisma.purchaseContract.findUniqueOrThrow({ where: { id: twoId } })).status).toBe('REVERSED');
    const sheet = await getLoadingSheet(companyId);
    expect(sheet.some((r) => r.contractId === twoId)).toBe(false);
    expect(sheet.some((r) => r.contractId === threeId)).toBe(true);
    // Both entries stay in the journal: the posting and its reversal.
    const entries = await prisma.journalEntry.count({ where: { companyId, sourceType: 'PURCHASE_CONTRACT', sourceId: twoId } });
    expect(entries).toBeGreaterThanOrEqual(2);
  }, 120_000);
});
