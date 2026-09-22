import { prisma } from '@/lib/db';
import { Decimal, dec, toMoney } from '@/lib/money';
import { LIVE_ENTRY_TEXT } from '@/lib/services/journal-visibility';
import { REFERENCE_SQL } from '@/lib/services/ledger';
import {
  INVOICE_DOCUMENTS_SQL,
  MEMO_SQL,
  ledgerTypeLabel,
  parseDocuments,
  type LedgerDocument,
} from '@/lib/services/ledger-sql';

/**
 * One agent's complete ledger.
 *
 * An agent is not only a commission earner. The same person collects
 * customers' money and cheques, hands it over, earns commission, lends the
 * company money and borrows from it. Every one of those postings is tagged
 * with the agent, whatever account it sits in — Agent Clearing, Commission
 * Payable, "Loan from <agent>", "Loan to <agent>", or a journal — so the
 * agent's ledger is simply every live journal line carrying their name.
 *
 * Nothing is copied into a second balance: the accounts stay what they are
 * on the balance sheet, and this view reads the same lines they do.
 *
 * It is kept in the company's own currency (MAD in Morocco), because that is
 * what the agent is actually paid and owed in; every row also keeps the
 * currency it was entered in and its USD equivalent at the rate of the day.
 * Debit means the agent owes the company more (they hold its money, or
 * borrowed); credit means the company owes the agent more (commission, or a
 * loan from them).
 */

export type AgentLedgerRow = {
  journalEntryId: string;
  entryNumber: string;
  entryDate: Date;
  sourceType: string;
  sourceId: string;
  reference: string | null;
  typeLabel: string;
  accountName: string;
  accountKey: string | null;
  customerName: string | null;
  documents: LedgerDocument[];
  memo: string | null;
  /** The currency the transaction was entered in, and its amounts in it. */
  currency: string;
  debit: Decimal;
  credit: Decimal;
  /** The same amounts in the company's own currency. */
  debitLocal: Decimal;
  creditLocal: Decimal;
  /** And in USD, as an equivalent only. */
  usd: Decimal;
  /** Running balance in the company's currency: positive = agent owes the company. */
  balanceLocal: Decimal;
  status: string;
  /** Which balance the line belongs to: what a reader needs to tell a cheque held from a loan. */
  accountKind: 'Agent Clearing' | 'Commission' | 'Loan from agent' | 'Loan to agent' | 'Other';
};

export type AgentLedgerSummary = {
  /** Customers' money the agent holds and has not handed over. */
  holdingLocal: Decimal;
  /** Commission the company owes the agent. */
  commissionLocal: Decimal;
  /** Money the agent lent the company and has not been repaid. */
  loanFromAgentLocal: Decimal;
  /** Money the company lent the agent and has not got back. */
  loanToAgentLocal: Decimal;
  /** Everything else tagged to the agent through journals. */
  otherLocal: Decimal;
  /** Positive: the agent owes the company. Negative: the company owes the agent. */
  netLocal: Decimal;
  netUsd: Decimal;
};

type Raw = {
  journalEntryId: string;
  entryNumber: string;
  entryDate: Date;
  sourceType: string;
  sourceId: string;
  lineDescription: string | null;
  currency: string;
  debit: string;
  credit: string;
  debitUsd: string;
  creditUsd: string;
  debitLocal: string;
  creditLocal: string;
  accountName: string;
  accountKey: string | null;
  customerName: string | null;
  reference: string | null;
  memo: string | null;
  documents: unknown;
  chequeStatus: string | null;
};

const CHEQUE_LABEL: Record<string, string> = {
  RECEIVED: 'Cheque with agent',
  DEPOSITED: 'Cheque deposited',
  CLEARED: 'Cheque cleared',
  BOUNCED: 'Cheque bounced',
  CANCELLED: 'Cheque cancelled',
};

const KIND = {
  holding: 'Agent Clearing',
  commission: 'Commission',
  loanFrom: 'Loan from agent',
  loanTo: 'Loan to agent',
  other: 'Other',
} as const;

function bucketOf(row: { accountKey: string | null; accountName: string }) {
  const name = row.accountName.toLowerCase();
  if (row.accountKey === 'AGENT_CLEARING') return 'holding' as const;
  if (row.accountKey === 'AGENT_COMMISSION_PAYABLE') return 'commission' as const;
  if (name.startsWith('loan from')) return 'loanFrom' as const;
  if (name.startsWith('loan to')) return 'loanTo' as const;
  return 'other' as const;
}

export async function getAgentLedger(params: {
  companyId: string;
  agentId: string;
}): Promise<{ rows: AgentLedgerRow[]; summary: AgentLedgerSummary }> {
  const raw = await prisma.$queryRawUnsafe<Raw[]>(
    `
    SELECT je."id" AS "journalEntryId", je."entryNumber", je."entryDate",
           je."sourceType"::text AS "sourceType", je."sourceId",
           jl."description" AS "lineDescription", jl."currency",
           jl."debit"::text AS debit, jl."credit"::text AS credit,
           jl."debitUsd"::text AS "debitUsd", jl."creditUsd"::text AS "creditUsd",
           jl."debitLocal"::text AS "debitLocal", jl."creditLocal"::text AS "creditLocal",
           acc."name" AS "accountName", acc."systemKey" AS "accountKey",
           COALESCE(
             c."customerName",
             CASE WHEN je."sourceType" = 'RECEIPT' THEN
               (SELECT cu."customerName" FROM receipts r JOIN customers cu ON cu."id" = r."customerId" WHERE r."id" = je."sourceId")
             END
           ) AS "customerName",
           ${REFERENCE_SQL} AS reference,
           ${MEMO_SQL} AS memo,
           ${INVOICE_DOCUMENTS_SQL} AS documents,
           CASE WHEN je."sourceType" = 'RECEIPT' THEN
             (SELECT ch."status"::text FROM cheques ch WHERE ch."receiptId" = je."sourceId" LIMIT 1)
           END AS "chequeStatus"
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts acc ON acc."id" = jl."accountId"
    LEFT JOIN customers c ON c."id" = jl."customerId"
    WHERE je."companyId" = $1
      AND ${LIVE_ENTRY_TEXT}
      AND jl."agentId" = $2
    ORDER BY je."entryDate" ASC, je."entryNumber" ASC, jl."lineNumber" ASC
    `,
    params.companyId,
    params.agentId,
  );

  const totals = { holding: dec(0), commission: dec(0), loanFrom: dec(0), loanTo: dec(0), other: dec(0) };
  let running = new Decimal(0);
  let usdNet = new Decimal(0);

  const rows = raw.map((row): AgentLedgerRow => {
    const debitLocal = dec(row.debitLocal);
    const creditLocal = dec(row.creditLocal);
    const movement = debitLocal.minus(creditLocal);
    running = toMoney(running.plus(movement));
    const usdMovement = dec(row.debitUsd).minus(dec(row.creditUsd));
    usdNet = usdNet.plus(usdMovement);
    totals[bucketOf(row)] = totals[bucketOf(row)].plus(movement);

    const documents = parseDocuments(row.documents).map((d) => ({ ...d, kind: 'INVOICE' as const }));
    const debit = dec(row.debit).greaterThan(0);
    let typeLabel = ledgerTypeLabel({
      sourceType: row.sourceType,
      documents,
      debit,
      accountKey: row.accountKey,
      accountName: row.accountName,
      agent: true,
    });
    if (row.sourceType === 'RECEIPT' && row.accountKey === 'AGENT_CLEARING' && debit) {
      typeLabel = row.chequeStatus ? 'Customer Cheque Collected' : 'Customer Payment Collected';
    }

    return {
      journalEntryId: row.journalEntryId,
      entryNumber: row.entryNumber,
      entryDate: row.entryDate,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      reference: row.reference,
      typeLabel,
      accountName: row.accountName,
      accountKey: row.accountKey,
      customerName: row.customerName,
      documents,
      memo: row.memo?.trim() || row.lineDescription?.trim() || null,
      currency: row.currency,
      debit: dec(row.debit),
      credit: dec(row.credit),
      debitLocal,
      creditLocal,
      usd: toMoney(usdMovement.abs()),
      balanceLocal: running,
      accountKind: KIND[bucketOf(row)],
      status: row.chequeStatus ? (CHEQUE_LABEL[row.chequeStatus] ?? 'Posted') : 'Posted',
    };
  });

  return {
    rows,
    summary: {
      holdingLocal: toMoney(totals.holding),
      // Credit-natured: shown as what the company owes.
      commissionLocal: toMoney(totals.commission.negated()),
      loanFromAgentLocal: toMoney(totals.loanFrom.negated()),
      loanToAgentLocal: toMoney(totals.loanTo),
      otherLocal: toMoney(totals.other),
      netLocal: running,
      netUsd: toMoney(usdNet),
    },
  };
}

/** Every agent's net position in the company's currency and in USD, from the same lines. */
export async function getAgentNetBalances(
  companyId: string,
): Promise<Map<string, { netLocal: Decimal; netUsd: Decimal }>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ agentId: string; local: string; usd: string }>>(
    `
    SELECT jl."agentId",
           COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS local,
           COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS usd
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    WHERE je."companyId" = $1
      AND ${LIVE_ENTRY_TEXT}
      AND jl."agentId" IS NOT NULL
    GROUP BY jl."agentId"
    `,
    companyId,
  );
  return new Map(rows.map((r) => [r.agentId, { netLocal: toMoney(r.local), netUsd: toMoney(r.usd) }]));
}

/**
 * Every active agent's balances, bucketed the same way as their ledger, in one
 * query: holding, commission, loans each way, and the net — in the company's
 * currency, with the net in USD as an equivalent.
 */
export async function getAgentSummaries(companyId: string): Promise<
  Array<{ agentId: string; agentName: string; summary: AgentLedgerSummary }>
> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ agentId: string; agentName: string; bucket: string; local: string; usd: string }>
  >(
    `
    SELECT a."id" AS "agentId", a."agentName",
           CASE
             WHEN acc."systemKey" = 'AGENT_CLEARING' THEN 'holding'
             WHEN acc."systemKey" = 'AGENT_COMMISSION_PAYABLE' THEN 'commission'
             WHEN lower(acc."name") LIKE 'loan from%' THEN 'loanFrom'
             WHEN lower(acc."name") LIKE 'loan to%' THEN 'loanTo'
             WHEN acc."id" IS NULL THEN 'none'
             ELSE 'other'
           END AS bucket,
           COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS local,
           COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS usd
    FROM agents a
    LEFT JOIN (
      journal_lines jl
      JOIN journal_entries je ON je."id" = jl."journalEntryId" AND ${LIVE_ENTRY_TEXT}
      JOIN accounts acc ON acc."id" = jl."accountId"
    ) ON jl."agentId" = a."id"
    WHERE a."companyId" = $1 AND a."status" = 'ACTIVE'
    GROUP BY a."id", a."agentName", bucket
    ORDER BY a."agentName"
    `,
    companyId,
  );

  const byAgent = new Map<string, { agentName: string; buckets: Record<string, { local: Decimal; usd: Decimal }> }>();
  for (const row of rows) {
    const entry = byAgent.get(row.agentId) ?? { agentName: row.agentName, buckets: {} };
    entry.buckets[row.bucket] = { local: dec(row.local), usd: dec(row.usd) };
    byAgent.set(row.agentId, entry);
  }

  return [...byAgent.entries()].map(([agentId, { agentName, buckets }]) => {
    const get = (k: string) => buckets[k]?.local ?? dec(0);
    const netLocal = ['holding', 'commission', 'loanFrom', 'loanTo', 'other'].reduce((t, k) => t.plus(get(k)), dec(0));
    const netUsd = ['holding', 'commission', 'loanFrom', 'loanTo', 'other'].reduce(
      (t, k) => t.plus(buckets[k]?.usd ?? dec(0)),
      dec(0),
    );
    return {
      agentId,
      agentName,
      summary: {
        holdingLocal: toMoney(get('holding')),
        commissionLocal: toMoney(get('commission').negated()),
        loanFromAgentLocal: toMoney(get('loanFrom').negated()),
        loanToAgentLocal: toMoney(get('loanTo')),
        otherLocal: toMoney(get('other')),
        netLocal: toMoney(netLocal),
        netUsd: toMoney(netUsd),
      },
    };
  });
}

/**
 * What the Agent Clearing and Agent Commission control accounts hold, and
 * how much of each is explained by lines carrying an agent's name.
 *
 * The agents are a subledger: they say who the control account's money is
 * with. They are not a second asset, and the balance sheet counts the
 * control account once. This is what lets a screen say so, and show the
 * difference if a posting ever reached the control account without naming
 * an agent — which would be a gap in the subledger, not extra money.
 */
export async function getAgentControlTotals(companyId: string): Promise<{
  clearingLocal: Decimal;
  clearingUsd: Decimal;
  clearingTaggedLocal: Decimal;
  commissionLocal: Decimal;
  commissionTaggedLocal: Decimal;
  /** Control less what the agents explain: nil when the subledger is complete. */
  untaggedLocal: Decimal;
  localCurrency: string;
}> {
  const [company, rows] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { localCurrency: true } }),
    prisma.$queryRawUnsafe<Array<{ key: string; tagged: boolean; local: string; usd: string }>>(
      `
      SELECT acc."systemKey" AS key,
             (jl."agentId" IS NOT NULL) AS tagged,
             COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS local,
             COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS usd
      FROM journal_lines jl
      JOIN journal_entries je ON je."id" = jl."journalEntryId"
      JOIN accounts acc ON acc."id" = jl."accountId"
      WHERE je."companyId" = $1
        AND ${LIVE_ENTRY_TEXT}
        AND acc."systemKey" IN ('AGENT_CLEARING', 'AGENT_COMMISSION_PAYABLE')
      GROUP BY acc."systemKey", (jl."agentId" IS NOT NULL)
      `,
      companyId,
    ),
  ]);

  const pick = (key: string, tagged?: boolean) =>
    toMoney(
      rows
        .filter((r) => r.key === key && (tagged === undefined || r.tagged === tagged))
        .reduce((total, r) => total.plus(dec(r.local)), dec(0)),
    );

  const clearingLocal = pick('AGENT_CLEARING');
  const clearingTaggedLocal = pick('AGENT_CLEARING', true);
  const commissionLocal = toMoney(pick('AGENT_COMMISSION_PAYABLE').negated());
  const commissionTaggedLocal = toMoney(pick('AGENT_COMMISSION_PAYABLE', true).negated());

  return {
    clearingLocal,
    clearingUsd: toMoney(
      rows.filter((r) => r.key === 'AGENT_CLEARING').reduce((total, r) => total.plus(dec(r.usd)), dec(0)),
    ),
    clearingTaggedLocal,
    commissionLocal,
    commissionTaggedLocal,
    untaggedLocal: toMoney(clearingLocal.minus(clearingTaggedLocal)),
    localCurrency: company.localCurrency,
  };
}
