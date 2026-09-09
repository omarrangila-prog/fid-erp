import { transaction } from '@/lib/db';
import type { Tx } from '@/lib/db';
import { Decimal, dec, toMoney, convertFromUsd } from '@/lib/money';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { BusinessRuleError } from '@/lib/errors';
import { postJournalEntry, type JournalLineInput } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { writeAudit } from '@/lib/services/audit';

/**
 * Foreign currency revaluation.
 *
 * A USD payable booked at MAD 9.85 and settled at MAD 10.00 leaves the USD
 * books square but the local books out by the rate movement. That difference is
 * a real gain or loss in the company's own currency, and it is recognised the
 * way every mainstream accounting package recognises it: as a periodic
 * revaluation, not silently inside the settlement voucher.
 *
 * For each account carried in a currency other than the company's own, this
 * compares the local-currency balance the ledger is carrying against what that
 * balance is worth at the rate supplied, and posts the difference to Foreign
 * Exchange Gain / Loss.
 *
 * The entries are local-currency-only: zero in USD, because in USD nothing
 * changed. Both currency dimensions stay balanced.
 */

export type RevaluationLine = {
  accountId: string;
  accountCode: string;
  accountName: string;
  currency: string;
  balanceUsd: Decimal;
  carriedLocal: Decimal;
  revaluedLocal: Decimal;
  differenceLocal: Decimal;
};

export type RevaluationPreview = {
  localCurrency: string;
  lines: RevaluationLine[];
  netDifferenceLocal: Decimal;
};

/**
 * Works out what a revaluation would post, without writing anything.
 * `rates` maps a currency code to units of that currency per 1 USD.
 */
export async function previewRevaluation(
  tx: Tx,
  params: { companyId: string; asOf: Date; rates: Record<string, string | number> },
): Promise<RevaluationPreview> {
  const company = await getCompanyContext(tx, params.companyId);
  const localCode = company.localCurrency.toUpperCase();

  // Grouped by account, not by account+currency: the revaluation entries this
  // function posts are themselves in the local currency, and they must offset
  // the very balance they are correcting rather than form a separate group.
  const rows = await tx.$queryRaw<
    Array<{
      accountId: string;
      code: string;
      name: string;
      currencies: string;
      usd: string;
      local: string;
      hasForeign: boolean;
    }>
  >`
    SELECT a."id" AS "accountId", a."code", a."name",
           string_agg(DISTINCT jl."currency", ',') AS currencies,
           SUM(jl."debitUsd"   - jl."creditUsd")::text   AS usd,
           SUM(jl."debitLocal" - jl."creditLocal")::text AS local,
           bool_or(jl."currency" <> ${localCode}) AS "hasForeign"
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${params.companyId}
      AND je."status" = 'POSTED'
      AND je."entryDate" <= ${params.asOf}::date
      AND a."type" IN ('ASSET', 'LIABILITY')
    GROUP BY a."id", a."code", a."name"
    -- A settled foreign balance is exactly the case revaluation exists for: it
    -- is zero in USD but still carries a local-currency difference.
    HAVING SUM(jl."debitUsd" - jl."creditUsd") <> 0
        OR SUM(jl."debitLocal" - jl."creditLocal") <> 0
  `;

  const lines: RevaluationLine[] = [];
  const localRate = params.rates[localCode];

  for (const row of rows) {
    // Only balances with genuine foreign-currency exposure can move on a rate.
    if (!row.hasForeign) continue;
    if (localRate === undefined) continue;

    const balanceUsd = toMoney(row.usd);
    const carriedLocal = toMoney(row.local);
    // What the USD position is worth in local money at the supplied rate.
    const revaluedLocal = convertFromUsd(balanceUsd, localRate, localCode);
    const differenceLocal = toMoney(revaluedLocal.minus(carriedLocal));

    if (differenceLocal.isZero()) continue;

    lines.push({
      accountId: row.accountId,
      accountCode: row.code,
      accountName: row.name,
      currency: (row.currencies ?? '')
        .split(',')
        .find((c) => c && c !== localCode) ?? 'USD',
      balanceUsd,
      carriedLocal,
      revaluedLocal,
      differenceLocal,
    });
  }

  return {
    localCurrency: localCode,
    lines,
    netDifferenceLocal: toMoney(lines.reduce((acc, l) => acc.plus(l.differenceLocal), new Decimal(0))),
  };
}

export async function postRevaluation(params: {
  companyId: string;
  asOf: Date;
  rates: Record<string, string | number>;
  userId: string;
}) {
  return transaction(async (tx) => {
    const company = await getCompanyContext(tx, params.companyId);
    const preview = await previewRevaluation(tx, params);

    if (preview.lines.length === 0) {
      throw new BusinessRuleError('Nothing needs revaluing at those rates.');
    }

    const localCode = company.localCurrency.toUpperCase();
    const journalLines: JournalLineInput[] = [];

    for (const line of preview.lines) {
      // A positive difference means the local carrying value is too low, so the
      // account is debited and the gain credited to FX.
      journalLines.push({
        accountId: line.accountId,
        direction: line.differenceLocal.greaterThan(0) ? 'DEBIT' : 'CREDIT',
        currency: localCode,
        amount: line.differenceLocal.abs(),
        rateToUsd: dec(params.rates[localCode] ?? 1),
        description: `Revaluation of ${line.currency} balance at ${params.asOf.toISOString().slice(0, 10)}`,
        localOnly: true,
      });
      journalLines.push({
        accountKey: ACCOUNT_KEYS.FX_GAIN_LOSS,
        direction: line.differenceLocal.greaterThan(0) ? 'CREDIT' : 'DEBIT',
        currency: localCode,
        amount: line.differenceLocal.abs(),
        rateToUsd: dec(params.rates[localCode] ?? 1),
        description: `Exchange ${line.differenceLocal.greaterThan(0) ? 'gain' : 'loss'} on ${line.accountName}`,
        localOnly: true,
      });
    }

    const entry = await postJournalEntry(tx, {
      companyId: params.companyId,
      entryDate: params.asOf,
      description: `Foreign currency revaluation at ${params.asOf.toISOString().slice(0, 10)}`,
      sourceType: 'MANUAL',
      sourceId: `REVAL-${params.asOf.toISOString().slice(0, 10)}`,
      createdById: params.userId,
      localCurrency: localCode,
      rateLocalPerUsd: params.rates[localCode] ?? 1,
      lines: journalLines,
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'FX_REVALUATION_POSTED',
      entityType: 'JournalEntry',
      entityId: entry.id,
      after: {
        asOf: params.asOf,
        rates: params.rates,
        netDifferenceLocal: preview.netDifferenceLocal,
        accounts: preview.lines.length,
      },
    });

    return { entry, preview };
  });
}
