import type { Tx } from '@/lib/db';
import { Decimal, dec, toMoney } from '@/lib/money';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { getSystemAccount, postJournalEntry, reverseJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { LIVE_ENTRY_WHERE } from '@/lib/services/journal-visibility';
import { writeAudit } from '@/lib/services/audit';

/**
 * Folding a separate import-tax correction back into the order's own posting.
 *
 * A purchase order from a foreign exporter posted before the rule "a foreign
 * supplier does not bill our TVA" existed carries TVA on its posting: AP was
 * credited with goods plus TVA and VAT Recoverable debited. A manual entry
 * (source `ap-import-tax-correction:<order>`) then took the TVA back off the
 * supplier. The books were right, but the journal carried a second entry the
 * client did not recognise.
 *
 * This removes that entry the way the application removes any posted entry —
 * a reversal, so the history stays in the audit trail and every screen leaves
 * the pair out — and reverses the order's original posting too, then posts
 * the order once more without the TVA it never carried. Every account, every
 * supplier balance and every date's balance sheet is exactly what it was
 * before; the transaction checks that and refuses to commit otherwise.
 */

const CORRECTION_PREFIX = 'ap-import-tax-correction:';

type BalanceKey = string;

/**
 * Every live account balance in USD and the company's currency — per party on
 * the accounts that keep a party sub-ledger (payables, receivables, agent
 * clearing), per account everywhere else. A party tag on a line of an
 * ordinary account moves nobody's balance, so it is not compared.
 */
async function balances(tx: Tx, companyId: string): Promise<Map<BalanceKey, { usd: Decimal; local: Decimal }>> {
  const rows = await tx.$queryRaw<Array<{ key: string; usd: string; local: string }>>`
    SELECT jl."accountId" || CASE WHEN a."subledgerType" <> 'NONE'
             THEN ':' || COALESCE(jl."vendorId", '') || ':' || COALESCE(jl."customerId", '') || ':' || COALESCE(jl."agentId", '')
             ELSE '' END AS key,
           SUM(jl."debitUsd" - jl."creditUsd")::text AS usd,
           SUM(jl."debitLocal" - jl."creditLocal")::text AS local
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND je."isReversal" = false
      AND NOT EXISTS (SELECT 1 FROM journal_entries rv WHERE rv."reversalOfId" = je."id")
    GROUP BY 1
  `;
  return new Map(rows.map((r) => [r.key, { usd: toMoney(r.usd), local: toMoney(r.local) }]));
}

function sameBalances(before: Map<BalanceKey, { usd: Decimal; local: Decimal }>, after: Map<BalanceKey, { usd: Decimal; local: Decimal }>) {
  const keys = new Set([...before.keys(), ...after.keys()]);
  const differences: string[] = [];
  for (const key of keys) {
    const a = before.get(key) ?? { usd: new Decimal(0), local: new Decimal(0) };
    const b = after.get(key) ?? { usd: new Decimal(0), local: new Decimal(0) };
    if (!a.usd.minus(b.usd).abs().lessThanOrEqualTo('0.0001') || !a.local.minus(b.local).abs().lessThanOrEqualTo('0.0001')) {
      differences.push(`${key}: USD ${a.usd} → ${b.usd}, local ${a.local} → ${b.local}`);
    }
  }
  return differences;
}

export async function foldImportTaxCorrectionIntoOrder(
  tx: Tx,
  params: { companyId: string; contractId: string; userId: string; reason: string; today: Date },
) {
  const correction = await tx.journalEntry.findFirst({
    where: { companyId: params.companyId, sourceType: 'MANUAL', sourceId: `${CORRECTION_PREFIX}${params.contractId}`, ...LIVE_ENTRY_WHERE },
    include: { lines: true },
  });
  if (!correction) throw new NotFoundError('Import-tax correction on this order');

  const postings = await tx.journalEntry.findMany({
    where: { companyId: params.companyId, sourceType: 'PURCHASE_CONTRACT', sourceId: params.contractId, ...LIVE_ENTRY_WHERE },
    include: { lines: { orderBy: { lineNumber: 'asc' } } },
  });
  if (postings.length !== 1) {
    throw new BusinessRuleError(`Expected one live posting of the order, found ${postings.length}.`);
  }
  const posting = postings[0];

  const vatAccount = await getSystemAccount(tx, params.companyId, ACCOUNT_KEYS.VAT_INPUT);
  const apAccount = await getSystemAccount(tx, params.companyId, ACCOUNT_KEYS.ACCOUNTS_PAYABLE);

  // The TVA the order posted, and the TVA the correction took back: they must be the same amount.
  const vatLines = posting.lines.filter((l) => l.accountId === vatAccount.id);
  const postedVat = vatLines.reduce((sum, l) => sum.plus(dec(l.debit)).minus(dec(l.credit)), new Decimal(0));
  const correctedVat = correction.lines
    .filter((l) => l.accountId === apAccount.id)
    .reduce((sum, l) => sum.plus(dec(l.debit)).minus(dec(l.credit)), new Decimal(0));
  if (postedVat.isZero() || !postedVat.equals(correctedVat)) {
    throw new BusinessRuleError(`The order posted ${postedVat} of TVA but the correction took back ${correctedVat}; nothing was changed.`);
  }

  // The order's posting as it should have been: no TVA line, the payable at goods value.
  const apLines = posting.lines.filter((l) => l.accountId === apAccount.id && dec(l.credit).greaterThan(0));
  if (apLines.length !== 1) throw new BusinessRuleError('The order posting has no single payable line to adjust.');
  const replacement = posting.lines
    .filter((l) => l.accountId !== vatAccount.id)
    .map((l) => {
      const isPayable = l.id === apLines[0].id;
      const debit = dec(l.debit);
      const credit = isPayable ? dec(l.credit).minus(postedVat) : dec(l.credit);
      return {
        accountId: l.accountId,
        direction: debit.greaterThan(0) ? ('DEBIT' as const) : ('CREDIT' as const),
        currency: l.currency,
        amount: debit.greaterThan(0) ? debit : credit,
        rateToUsd: l.rateToUsd,
        description: l.description ?? undefined,
        vendorId: l.vendorId,
        customerId: l.customerId,
        shipmentId: l.shipmentId,
        purchaseContractId: l.purchaseContractId,
        itemId: l.itemId,
        batchId: l.batchId,
      };
    });

  const before = await balances(tx, params.companyId);

  await reverseJournalEntry(tx, {
    companyId: params.companyId,
    sourceType: 'MANUAL',
    sourceId: correction.sourceId,
    entryId: correction.id,
    createdById: params.userId,
    entryDate: params.today,
    reason: params.reason,
  });
  await reverseJournalEntry(tx, {
    companyId: params.companyId,
    sourceType: 'PURCHASE_CONTRACT',
    sourceId: posting.sourceId,
    entryId: posting.id,
    createdById: params.userId,
    entryDate: params.today,
    reason: `${params.reason} — reposted without the TVA the supplier does not bill`,
  });

  const company = await getCompanyContext(tx, params.companyId);
  const reposted = await postJournalEntry(tx, {
    companyId: params.companyId,
    entryDate: posting.entryDate,
    description: posting.description,
    sourceType: 'PURCHASE_CONTRACT',
    sourceId: posting.sourceId,
    createdById: params.userId,
    localCurrency: company.localCurrency,
    rateLocalPerUsd: posting.lines[0].rateLocalPerUsd,
    lines: replacement,
  });

  const after = await balances(tx, params.companyId);
  const differences = sameBalances(before, after);
  if (differences.length > 0) {
    throw new BusinessRuleError(`Refused: the change would move balances — ${differences.join('; ')}`);
  }

  await writeAudit(tx, {
    companyId: params.companyId,
    userId: params.userId,
    action: 'IMPORT_TAX_CORRECTION_FOLDED',
    entityType: 'PurchaseContract',
    entityId: params.contractId,
    before: { correction: correction.entryNumber, posting: posting.entryNumber, tvaOnPosting: postedVat.toString() },
    after: { posting: reposted.entryNumber, tvaOnPosting: '0', reason: params.reason },
  });

  return { removed: correction.entryNumber, replaced: posting.entryNumber, reposted: reposted.entryNumber, vat: postedVat };
}
