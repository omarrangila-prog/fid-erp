import 'dotenv/config';
import { prisma, transaction } from '@/lib/db';
import { Decimal, dec, toMoney } from '@/lib/money';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { postJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { writeAudit } from '@/lib/services/audit';

/**
 * Clears the receivable/advance residue left by settling in USD.
 *
 * A receipt used to clear a customer's invoice by comparing the money and
 * the invoice in USD. When the rate had moved between the two, an invoice
 * paid in full in its own currency was only partly cleared: the rest went to
 * Customer Advances. The customer's statement then showed an amount owing
 * and a credit of the same size, and the two cancelled in USD so no check
 * reported it.
 *
 * Settlement now happens at the value the document was booked at, and the
 * difference is posted as a realised exchange gain or loss. This repairs the
 * documents posted before that: for each customer, whatever sits as an
 * unapplied advance while their own invoices are fully paid is moved back
 * onto the receivable, and the currency difference is recognised where it
 * belonged all along.
 *
 * Nothing is deleted and no posted entry is edited. One correcting journal
 * per customer, keyed so a second run does nothing.
 *
 *   npx tsx scripts/correct-receipt-fx-residue.ts            # report only
 *   npx tsx scripts/correct-receipt-fx-residue.ts --confirm  # post
 */

const SOURCE_PREFIX = 'receipt-fx-residue:';

function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

type Position = {
  companyId: string;
  companyCode: string;
  customerId: string;
  customerName: string;
  currency: string;
  /** Receivable still carried in the customer's currency, though nothing is owed. */
  receivableLocal: Decimal;
  receivableUsd: Decimal;
  /** The matching advance, carried negative (a credit). */
  advanceLocal: Decimal;
  advanceUsd: Decimal;
};

async function positions(): Promise<Position[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      companyId: string;
      companyCode: string;
      customerId: string;
      customerName: string;
      currency: string;
      arNative: string;
      arUsd: string;
      advNative: string;
      advUsd: string;
      openDocs: string;
    }>
  >`
    WITH ledger AS (
      SELECT je."companyId", jl."customerId", jl."currency", a."systemKey",
             SUM(jl."debit" - jl."credit") AS native,
             SUM(jl."debitUsd" - jl."creditUsd") AS usd
      FROM journal_lines jl
      JOIN journal_entries je ON je."id" = jl."journalEntryId"
      JOIN accounts a ON a."id" = jl."accountId"
      WHERE je."status" = 'POSTED'
        AND jl."customerId" IS NOT NULL
        AND a."systemKey" IN ('ACCOUNTS_RECEIVABLE', 'CUSTOMER_ADVANCES')
      GROUP BY je."companyId", jl."customerId", jl."currency", a."systemKey"
    )
    SELECT co."id" AS "companyId", co."code" AS "companyCode",
           cu."id" AS "customerId", cu."customerName", l."currency",
           COALESCE(SUM(CASE WHEN l."systemKey" = 'ACCOUNTS_RECEIVABLE' THEN l.native END), 0)::text AS "arNative",
           COALESCE(SUM(CASE WHEN l."systemKey" = 'ACCOUNTS_RECEIVABLE' THEN l.usd END), 0)::text AS "arUsd",
           COALESCE(SUM(CASE WHEN l."systemKey" = 'CUSTOMER_ADVANCES' THEN l.native END), 0)::text AS "advNative",
           COALESCE(SUM(CASE WHEN l."systemKey" = 'CUSTOMER_ADVANCES' THEN l.usd END), 0)::text AS "advUsd",
           (SELECT COUNT(*) FROM sales_invoices si
             WHERE si."customerId" = cu."id" AND si."status" = 'POSTED'
               AND si."totalAmount" > (
                 SELECT COALESCE(SUM(ra."amount"), 0) FROM receipt_allocations ra
                 JOIN receipts r ON r."id" = ra."receiptId"
                 WHERE ra."salesInvoiceId" = si."id" AND r."status" = 'POSTED'
               ))::text AS "openDocs"
    FROM ledger l
    JOIN customers cu ON cu."id" = l."customerId"
    JOIN companies co ON co."id" = l."companyId"
    GROUP BY co."id", co."code", cu."id", cu."customerName", l."currency"`;

  return rows
    .filter((row) => {
      const ar = dec(row.arNative);
      const adv = dec(row.advNative);
      // The signature: a receivable and an advance of the same size and
      // opposite sign, with no invoice actually outstanding.
      return (
        Number(row.openDocs) === 0 &&
        ar.greaterThan('0.005') &&
        adv.lessThan('-0.005') &&
        ar.plus(adv).abs().lessThanOrEqualTo('0.05')
      );
    })
    .map((row) => ({
      companyId: row.companyId,
      companyCode: row.companyCode,
      customerId: row.customerId,
      customerName: row.customerName,
      currency: row.currency,
      receivableLocal: toMoney(row.arNative),
      receivableUsd: toMoney(row.arUsd),
      advanceLocal: toMoney(row.advNative),
      advanceUsd: toMoney(row.advUsd),
    }));
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const found = await positions();

  if (found.length === 0) {
    console.log('No receivable/advance residue found.');
    return;
  }

  const admin = await prisma.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } });

  for (const position of found) {
    const amount = position.receivableLocal;
    // The USD the advance carries is the exchange difference that was never
    // recognised: the receivable is already square in USD.
    const fxUsd = toMoney(position.advanceUsd.negated().minus(position.receivableUsd));

    console.log(
      `${position.companyCode} ${position.customerName}: ${position.currency} ${amount.toFixed(2)} on receivables, ` +
        `${position.currency} ${position.advanceLocal.negated().toFixed(2)} in advances, ` +
        `USD ${fxUsd.toFixed(2)} exchange ${fxUsd.greaterThan(0) ? 'gain' : 'loss'} to recognise`,
    );

    if (!confirm) continue;

    const sourceId = `${SOURCE_PREFIX}${position.customerId}:${position.currency}`;
    await transaction(async (tx) => {
      const already = await tx.journalEntry.findFirst({
        where: { companyId: position.companyId, sourceType: 'MANUAL', sourceId },
        select: { id: true },
      });
      if (already) {
        console.log('  already corrected');
        return;
      }

      const company = await getCompanyContext(tx, position.companyId);
      const rateToUsd = position.receivableLocal.dividedBy(
        position.advanceUsd.negated().isZero() ? 1 : position.advanceUsd.negated(),
      );

      const entry = await postJournalEntry(tx, {
        companyId: position.companyId,
        entryDate: todayUtc(),
        description: `Apply ${position.customerName}'s advance to their settled invoices`,
        sourceType: 'MANUAL',
        sourceId,
        createdById: admin.id,
        localCurrency: company.localCurrency,
        rateLocalPerUsd: rateToUsd,
        lines: [
          {
            accountKey: ACCOUNT_KEYS.CUSTOMER_ADVANCES,
            direction: 'DEBIT',
            currency: position.currency,
            amount,
            rateToUsd,
            bookedUsd: position.advanceUsd.negated(),
            bookedLocal: amount,
            description: 'Advance applied to invoices already settled in full',
            customerId: position.customerId,
          },
          {
            accountKey: ACCOUNT_KEYS.ACCOUNTS_RECEIVABLE,
            direction: 'CREDIT',
            currency: position.currency,
            amount,
            rateToUsd,
            // The receivable is already square in USD: only the currency
            // amount is being cleared here.
            bookedUsd: new Decimal(0),
            bookedLocal: amount,
            description: 'Receivable cleared — the invoices were paid in full',
            customerId: position.customerId,
          },
          {
            accountKey: ACCOUNT_KEYS.FX_GAIN_LOSS,
            direction: fxUsd.greaterThan(0) ? 'CREDIT' : 'DEBIT',
            currency: 'USD',
            amount: fxUsd.abs(),
            rateToUsd: 1,
            bookedUsd: fxUsd.abs(),
            // Nothing in the company's own currency: the dirhams that arrived
            // are the dirhams that were owed.
            bookedLocal: new Decimal(0),
            description: 'Exchange difference realised when the invoice was settled',
            customerId: position.customerId,
          },
        ],
      });

      await writeAudit(tx, {
        companyId: position.companyId,
        userId: admin.id,
        action: 'RECEIPT_FX_RESIDUE_CORRECTED',
        entityType: 'Customer',
        entityId: position.customerId,
        before: {
          receivable: position.receivableLocal.toString(),
          advance: position.advanceLocal.toString(),
          currency: position.currency,
        },
        after: { receivable: '0', advance: '0', exchangeUsd: fxUsd.toString(), entryNumber: entry.entryNumber },
      });

      console.log(`  corrected by ${entry.entryNumber}`);
    });
  }

  if (!confirm) console.log('\nReport only. Re-run with --confirm to post the corrections.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
