import { prisma, transaction } from '@/lib/db';
import { Decimal, dec, toMoney } from '@/lib/money';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { BusinessRuleError, ConflictError, NotFoundError } from '@/lib/errors';
import { writeAudit } from '@/lib/services/audit';
import { getTaxSettings } from '@/lib/services/tax';

/**
 * The tax return: VAT 201 in the UAE, the TVA declaration in Morocco.
 *
 * Figures are built from the documents, not from the ledger, because a return
 * has to state a taxable *base* alongside the tax — and a base broken down by
 * treatment, since a zero-rated export and an exempt supply are reported on
 * different lines even though both charge nothing.
 *
 * The ledger is then used as an independent check. Output tax computed from
 * the invoices must equal the movement on the VAT Payable control account for
 * the same period, and input tax must equal the movement on VAT Recoverable.
 * A difference means something posted to those accounts that no document
 * explains — a manual journal, usually — and the screen says so rather than
 * quietly filing a number that cannot be traced.
 *
 * Every figure is in the company's local currency, which is the currency the
 * authority expects.
 */

export type TaxReturnBand = {
  code: string;
  label: string;
  treatment: string;
  ratePct: string;
  netLocal: string;
  taxLocal: string;
  documentCount: number;
};

export type TaxReturnFigures = {
  label: string;
  registrationNumber: string | null;
  localCurrency: string;
  periodStart: Date;
  periodEnd: Date;
  sales: TaxReturnBand[];
  purchases: TaxReturnBand[];
  outputTax: string;
  inputTax: string;
  netPayable: string;
  standardSales: string;
  zeroRatedSales: string;
  exemptSales: string;
  totalPurchases: string;
  /** The same two totals taken straight off the control accounts. */
  ledgerOutputTax: string;
  ledgerInputTax: string;
  outputDifference: string;
  inputDifference: string;
  reconciled: boolean;
  filed: { id: string; reference: string | null; filedAt: Date | null } | null;
};

type BandRow = {
  code: string | null;
  name: string | null;
  treatment: string | null;
  ratePct: string | null;
  net: string;
  tax: string;
  documents: bigint | number;
};

function toBands(rows: BandRow[]): TaxReturnBand[] {
  return rows.map((row) => ({
    code: row.code ?? 'NONE',
    label: row.name ?? 'No tax code',
    treatment: row.treatment ?? 'OUT_OF_SCOPE',
    ratePct: dec(row.ratePct ?? 0).toFixed(2),
    netLocal: toMoney(row.net).toFixed(2),
    taxLocal: toMoney(row.tax).toFixed(2),
    documentCount: Number(row.documents),
  }));
}

function totalOf(bands: TaxReturnBand[], field: 'netLocal' | 'taxLocal'): Decimal {
  return bands.reduce((sum, band) => sum.plus(band[field]), new Decimal(0));
}

/** Movement on a tax control account over a period, in local currency. */
async function controlMovement(
  companyId: string,
  systemKey: string,
  from: Date,
  to: Date,
  side: 'credit' | 'debit',
): Promise<Decimal> {
  const rows = await prisma.$queryRaw<Array<{ total: string }>>`
    SELECT COALESCE(SUM(
      CASE WHEN ${side} = 'credit'
           THEN jl."creditLocal" - jl."debitLocal"
           ELSE jl."debitLocal" - jl."creditLocal" END
    ), 0)::text AS total
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId}
      AND je."status" = 'POSTED'
      AND a."systemKey" = ${systemKey}
      AND je."entryDate" >= ${from}::date
      AND je."entryDate" <= ${to}::date`;
  return toMoney(rows[0]?.total ?? 0);
}

export async function getTaxReturn(params: {
  companyId: string;
  from: Date;
  to: Date;
}): Promise<TaxReturnFigures> {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: params.companyId },
    select: { localCurrency: true },
  });
  const settings = await getTaxSettings(params.companyId);

  // Sales: invoices raised in the period, less credits raised in the period.
  //
  // Local currency comes from each document's own rateLocalPerUsd, the rate
  // captured when it was posted — the same rate its journal entry used, so the
  // return and the ledger are comparing like with like.
  const salesRows = await prisma.$queryRaw<BandRow[]>`
    WITH doc AS (
      SELECT tc."code", tc."name", tc."treatment"::text AS treatment, sil."taxRatePct"::text AS "ratePct",
             sil."lineTotalUsd" * si."rateLocalPerUsd" AS net,
             sil."taxAmountUsd" * si."rateLocalPerUsd" AS tax,
             si."id" AS doc_id
      FROM sales_invoice_lines sil
      JOIN sales_invoices si ON si."id" = sil."salesInvoiceId"
      LEFT JOIN tax_codes tc ON tc."id" = sil."taxCodeId"
      WHERE si."companyId" = ${params.companyId}
        AND si."status" = 'POSTED'
        AND si."invoiceDate" >= ${params.from}::date
        AND si."invoiceDate" <= ${params.to}::date
      UNION ALL
      SELECT tc."code", tc."name", tc."treatment"::text, cnl."taxRatePct"::text,
             -cnl."lineTotalUsd" * cn."rateLocalPerUsd",
             -cnl."taxAmountUsd" * cn."rateLocalPerUsd",
             cn."id"
      FROM credit_note_lines cnl
      JOIN credit_notes cn ON cn."id" = cnl."creditNoteId"
      LEFT JOIN tax_codes tc ON tc."id" = cnl."taxCodeId"
      WHERE cn."companyId" = ${params.companyId}
        AND cn."status" = 'POSTED'
        AND cn."type" = 'CUSTOMER'
        AND cn."creditDate" >= ${params.from}::date
        AND cn."creditDate" <= ${params.to}::date
    )
    SELECT "code", "name", treatment, "ratePct",
           SUM(net)::text AS net, SUM(tax)::text AS tax,
           COUNT(DISTINCT doc_id) AS documents
    FROM doc
    GROUP BY "code", "name", treatment, "ratePct"
    ORDER BY treatment, "code"`;

  // Purchases: contracts approved in the period and expenses posted in it,
  // less supplier credits. Both are input tax the business can reclaim.
  const purchaseRows = await prisma.$queryRaw<BandRow[]>`
    WITH doc AS (
      SELECT tc."code", tc."name", tc."treatment"::text AS treatment, pcl."taxRatePct"::text AS "ratePct",
             (pcl."lineTotal" / NULLIF(pc."rateToUsd", 0)) * pc."rateLocalPerUsd" AS net,
             pcl."taxAmountUsd" * pc."rateLocalPerUsd" AS tax,
             pc."id" AS doc_id
      FROM purchase_contract_lines pcl
      JOIN purchase_contracts pc ON pc."id" = pcl."purchaseContractId"
      LEFT JOIN tax_codes tc ON tc."id" = pcl."taxCodeId"
      WHERE pc."companyId" = ${params.companyId}
        AND pc."status" = 'POSTED'
        AND pc."contractDate" >= ${params.from}::date
        AND pc."contractDate" <= ${params.to}::date
      UNION ALL
      SELECT tc."code", tc."name", tc."treatment"::text, e."taxRatePct"::text,
             e."amountUsd" * e."rateLocalPerUsd",
             e."taxAmountUsd" * e."rateLocalPerUsd",
             e."id"
      FROM expenses e
      LEFT JOIN tax_codes tc ON tc."id" = e."taxCodeId"
      WHERE e."companyId" = ${params.companyId}
        AND e."status" = 'POSTED'
        AND e."expenseDate" >= ${params.from}::date
        AND e."expenseDate" <= ${params.to}::date
      UNION ALL
      SELECT tc."code", tc."name", tc."treatment"::text, cnl."taxRatePct"::text,
             -cnl."lineTotalUsd" * cn."rateLocalPerUsd",
             -cnl."taxAmountUsd" * cn."rateLocalPerUsd",
             cn."id"
      FROM credit_note_lines cnl
      JOIN credit_notes cn ON cn."id" = cnl."creditNoteId"
      LEFT JOIN tax_codes tc ON tc."id" = cnl."taxCodeId"
      WHERE cn."companyId" = ${params.companyId}
        AND cn."status" = 'POSTED'
        AND cn."type" = 'VENDOR'
        AND cn."creditDate" >= ${params.from}::date
        AND cn."creditDate" <= ${params.to}::date
    )
    SELECT "code", "name", treatment, "ratePct",
           SUM(net)::text AS net, SUM(tax)::text AS tax,
           COUNT(DISTINCT doc_id) AS documents
    FROM doc
    GROUP BY "code", "name", treatment, "ratePct"
    ORDER BY treatment, "code"`;

  const sales = toBands(salesRows);
  const purchases = toBands(purchaseRows);

  const outputTax = toMoney(totalOf(sales, 'taxLocal'));
  const inputTax = toMoney(totalOf(purchases, 'taxLocal'));
  const netPayable = toMoney(outputTax.minus(inputTax));

  const byTreatment = (treatment: string) =>
    toMoney(sales.filter((band) => band.treatment === treatment).reduce((s, b) => s.plus(b.netLocal), new Decimal(0)));

  const ledgerOutputTax = await controlMovement(
    params.companyId,
    ACCOUNT_KEYS.VAT_OUTPUT,
    params.from,
    params.to,
    'credit',
  );
  const ledgerInputTax = await controlMovement(
    params.companyId,
    ACCOUNT_KEYS.VAT_INPUT,
    params.from,
    params.to,
    'debit',
  );

  const outputDifference = toMoney(outputTax.minus(ledgerOutputTax));
  const inputDifference = toMoney(inputTax.minus(ledgerInputTax));

  const filed = await prisma.taxReturn.findFirst({
    where: { companyId: params.companyId, periodStart: params.from, periodEnd: params.to },
    select: { id: true, reference: true, filedAt: true, status: true },
  });

  return {
    label: settings.label,
    registrationNumber: settings.registrationNumber,
    localCurrency: company.localCurrency,
    periodStart: params.from,
    periodEnd: params.to,
    sales,
    purchases,
    outputTax: outputTax.toFixed(2),
    inputTax: inputTax.toFixed(2),
    netPayable: netPayable.toFixed(2),
    standardSales: byTreatment('STANDARD').toFixed(2),
    zeroRatedSales: byTreatment('ZERO_RATED').toFixed(2),
    exemptSales: byTreatment('EXEMPT').toFixed(2),
    totalPurchases: toMoney(totalOf(purchases, 'netLocal')).toFixed(2),
    ledgerOutputTax: ledgerOutputTax.toFixed(2),
    ledgerInputTax: ledgerInputTax.toFixed(2),
    outputDifference: outputDifference.toFixed(2),
    inputDifference: inputDifference.toFixed(2),
    // Sub-cent tolerance: per-line rounding on documents against per-entry
    // rounding in the ledger can differ in the last place, and no authority
    // cares about a hundredth of a dirham.
    reconciled: outputDifference.abs().lessThan('0.05') && inputDifference.abs().lessThan('0.05'),
    filed: filed && filed.status === 'FILED' ? { id: filed.id, reference: filed.reference, filedAt: filed.filedAt } : null,
  };
}

/**
 * Records a period as filed, freezing the figures as submitted.
 *
 * Refuses when the figures do not tie to the ledger: filing a number you cannot
 * trace to a posting is how an assessment becomes a penalty.
 */
export async function fileTaxReturn(params: {
  companyId: string;
  userId: string;
  from: Date;
  to: Date;
  reference?: string | null;
  notes?: string | null;
}) {
  const figures = await getTaxReturn({ companyId: params.companyId, from: params.from, to: params.to });

  if (!figures.reconciled) {
    throw new BusinessRuleError(
      `The return does not agree with the ledger — output tax differs by ${figures.outputDifference} and input tax by ${figures.inputDifference}. Find the entry that explains the gap before filing.`,
    );
  }

  return transaction(async (tx) => {
    const existing = await tx.taxReturn.findFirst({
      where: { companyId: params.companyId, periodStart: params.from, periodEnd: params.to },
    });
    if (existing?.status === 'FILED') {
      throw new ConflictError('That period has already been filed. Correct it on the next return instead.');
    }

    const data = {
      status: 'FILED' as const,
      outputTax: dec(figures.outputTax),
      inputTax: dec(figures.inputTax),
      netPayable: dec(figures.netPayable),
      standardSales: dec(figures.standardSales),
      zeroRatedSales: dec(figures.zeroRatedSales),
      exemptSales: dec(figures.exemptSales),
      purchases: dec(figures.totalPurchases),
      reference: params.reference?.trim() || null,
      notes: params.notes ?? null,
      filedAt: new Date(),
      filedById: params.userId,
    };

    const saved = existing
      ? await tx.taxReturn.update({ where: { id: existing.id }, data })
      : await tx.taxReturn.create({
          data: {
            companyId: params.companyId,
            periodStart: params.from,
            periodEnd: params.to,
            createdById: params.userId,
            ...data,
          },
        });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'TAX_RETURN_FILED',
      entityType: 'TaxReturn',
      entityId: saved.id,
      after: {
        period: `${params.from.toISOString().slice(0, 10)} → ${params.to.toISOString().slice(0, 10)}`,
        outputTax: figures.outputTax,
        inputTax: figures.inputTax,
        netPayable: figures.netPayable,
      },
    });

    return saved;
  });
}

export async function listTaxReturns(companyId: string) {
  return prisma.taxReturn.findMany({
    where: { companyId },
    orderBy: { periodStart: 'desc' },
    include: { filedBy: { select: { name: true } } },
  });
}

export async function getTaxReturnById(companyId: string, id: string) {
  const found = await prisma.taxReturn.findFirst({ where: { id, companyId } });
  if (!found) throw new NotFoundError('Tax return');
  return found;
}

/**
 * The period a return is being prepared for: the most recent complete filing
 * period, counted back from today in the company's own cadence.
 */
export function currentTaxPeriod(periodMonths: number, today = new Date()): { from: Date; to: Date } {
  const months = Math.max(1, periodMonths);
  const year = today.getUTCFullYear();
  const monthIndex = today.getUTCMonth();
  const periodIndex = Math.floor(monthIndex / months);
  const startMonth = periodIndex * months;

  // The period that has just ended is the one to file, so step back one.
  const from = new Date(Date.UTC(year, startMonth - months, 1));
  const to = new Date(Date.UTC(year, startMonth, 0));
  return { from, to };
}
