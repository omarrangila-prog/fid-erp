import 'dotenv/config';
import fs from 'node:fs';
import { prisma } from '@/lib/db';
import { dec } from '@/lib/money';

/**
 * Shipments whose goods are in the warehouse but whose status never moved.
 *
 * Receiving a container used to leave the shipment's own status alone, so a
 * client who received goods without first pressing "Mark arrived" ended up
 * with an order reading "0 of 2 arrived" while the coffee was on the shelf.
 * The engine now moves the status when the goods are counted in; this brings
 * the shipments already in that state up to date.
 *
 * Nothing is invented. A shipment is only moved when a POSTED goods receipt
 * proves the cargo was counted into a warehouse, and only ever forwards —
 * anything already arrived, cleared or delivered is left alone. No quantity,
 * amount, journal or stock figure is touched: this writes a status and an
 * arrival date, and records why.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/repair-stranded-shipments.ts           # dry run
 *   npx tsx --tsconfig tsconfig.json scripts/repair-stranded-shipments.ts --apply   # write
 */

const IN_TRANSIT = ['CONTRACT_CREATED', 'AWAITING_LOADING', 'LOADED', 'IN_TRANSIT'];
const apply = process.argv.includes('--apply');

async function main() {
  const companies = await prisma.company.findMany({ select: { id: true, code: true, name: true } });
  const planned: Array<{
    company: string;
    shipmentId: string;
    shipmentNumber: string;
    reference: string | null;
    status: string;
    receiptDate: string;
    grn: string;
    receivedKg: string;
  }> = [];

  for (const company of companies) {
    const shipments = await prisma.shipment.findMany({
      where: { companyId: company.id, status: { in: IN_TRANSIT as never } },
      select: {
        id: true,
        shipmentNumber: true,
        status: true,
        ataDate: true,
        purchaseContract: { select: { contractReference: true } },
        batches: { select: { id: true, receivedQuantityKg: true } },
      },
    });

    for (const shipment of shipments) {
      const receivedKg = shipment.batches.reduce((total, b) => total.plus(dec(b.receivedQuantityKg)), dec(0));
      if (receivedKg.lessThanOrEqualTo(0)) continue;

      /*
       * The proof is a posted receipt that counted one of this shipment's
       * batches in — found through the batch, not through the receipt's own
       * shipment link, because a receipt taken against the whole order does
       * not carry one. Looking only at that link is what made this repair
       * report nothing the first time it ran.
       */
      const proofLine = await prisma.goodsReceiptLine.findFirst({
        where: {
          batchId: { in: shipment.batches.map((b) => b.id) },
          goodsReceipt: { companyId: company.id, status: 'POSTED' },
        },
        orderBy: { goodsReceipt: { receiptDate: 'asc' } },
        select: { goodsReceipt: { select: { grnNumber: true, receiptDate: true } } },
      });
      const proof = proofLine?.goodsReceipt;
      if (!proof) continue;

      planned.push({
        company: company.code,
        shipmentId: shipment.id,
        shipmentNumber: shipment.shipmentNumber,
        reference: shipment.purchaseContract?.contractReference ?? null,
        status: shipment.status,
        receiptDate: proof.receiptDate.toISOString().slice(0, 10),
        grn: proof.grnNumber,
        receivedKg: receivedKg.toString(),
      });
    }
  }

  for (const row of planned) {
    console.log(
      `  ${row.company}  ${row.reference ?? row.shipmentNumber}  ${row.status} → ARRIVED  ` +
        `(${row.receivedKg} KG received on ${row.grn}, ${row.receiptDate})`,
    );
  }

  if (planned.length === 0) {
    console.log('  nothing stranded — every shipment with received goods already reads as arrived');
    return;
  }
  if (!apply) {
    console.log(`dry run — ${planned.length} shipment(s) to bring up to date. Pass --apply to write.`);
    return;
  }

  const file = `backups/repair-stranded-shipments-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), planned }, null, 2));
  console.log('  backup written:', file);

  for (const row of planned) {
    const shipment = await prisma.shipment.findUniqueOrThrow({
      where: { id: row.shipmentId },
      select: { companyId: true, ataDate: true },
    });
    await prisma.shipment.update({
      where: { id: row.shipmentId },
      data: {
        status: 'ARRIVED',
        ataDate: shipment.ataDate ?? new Date(`${row.receiptDate}T00:00:00.000Z`),
      },
    });
    await prisma.auditLog.create({
      data: {
        companyId: shipment.companyId,
        action: 'SHIPMENT_ARRIVED_ON_RECEIPT',
        entityType: 'Shipment',
        entityId: row.shipmentId,
        before: { status: row.status },
        after: {
          status: 'ARRIVED',
          because: `Goods received on ${row.grn}`,
          note: 'Brought up to date after receiving stopped leaving the status behind',
        },
      },
    });
  }

  console.log(`  brought ${planned.length} shipment(s) up to date; no quantity, amount or journal touched`);
}

main().finally(() => prisma.$disconnect());
