import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { prisma, transaction } from '@/lib/db';
import { dec } from '@/lib/money';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { updateExpense } from '@/lib/services/expense';
import { deletePostedEntry } from '@/lib/services/document-lifecycle';
import { postLoan } from '@/lib/services/loan';
import { getAgentStatement } from '@/lib/services/agent-statement';

/**
 * Put RADOUAN MOHAMMED's two stray balances where they belong, by his agent id.
 *
 *   1. His commission on ICUL/FID/002 (FID-MA-EV-000021, MAD 31,190.40, memo
 *      "commission Radouan 80$/per ton…") was booked owed to nobody, so it sat
 *      in Accrued Expenses and not on his ledger. It is named as owed to him,
 *      through the cost's own edit: the liability moves to Agent Commission
 *      Payable under his name; the cost, its shipment and its landed cost do
 *      not change.
 *
 *   2. The MAD 27,468.50 he put into Cash in Hand on 12 August
 *      (FID-MA-JV-000091, "Loan received from RADOUAN MOHAMMED on 12 August")
 *      was credited to Agent Clearing — as if he had handed over customer money
 *      — and not to "Loan from RADOUAN MOHAMMED". It is deleted the way the app
 *      deletes a voucher (reversed, reason on the audit trail) and entered
 *      again as his loan on the same day, as FID-MA-JV-000089 was corrected
 *      before: collections held go back to the MAD 46,000 he collected.
 *
 * Nothing else is touched. A backup of every row touched is written
 * to backups/ first. The dry run does everything inside a transaction and
 * rolls it back; only --apply writes.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/correct-radouan-links.ts           # dry run
 *   npx tsx --tsconfig tsconfig.json scripts/correct-radouan-links.ts --apply   # write
 */

const APPLY = process.argv.includes('--apply');
const COMMISSION = 'FID-MA-EV-000021';
const MISFILED = 'FID-MA-JV-000091';

class DryRun extends Error {}

async function main() {
  const company = await prisma.company.findFirstOrThrow({ where: { code: 'FID-MA' }, select: { id: true, localCurrency: true } });
  const companyId = company.id;
  const agent = await prisma.agent.findFirstOrThrow({ where: { companyId, agentName: 'RADOUAN MOHAMMED' }, select: { id: true } });
  const admin = await prisma.user.findFirstOrThrow({ where: { name: 'Ali Raza' }, select: { id: true } });
  const expense = await prisma.expense.findFirstOrThrow({ where: { companyId, expenseNumber: COMMISSION } });
  const jv = await prisma.journalEntry.findFirstOrThrow({
    where: { companyId, entryNumber: MISFILED },
    include: { lines: { include: { account: { select: { systemKey: true, name: true } } } } },
  });

  // Guards: act only on exactly what was traced.
  if (expense.payableToAgentId) throw new Error(`${COMMISSION} is already owed to an agent; nothing to do.`);
  if (expense.status !== 'POSTED' || expense.cashBankAccountId) throw new Error(`${COMMISSION} is not a posted unpaid cost.`);
  const clearingLine = jv.lines.find((l) => l.account.systemKey === ACCOUNT_KEYS.AGENT_CLEARING && l.agentId === agent.id);
  if (!clearingLine || dec(clearingLine.credit).toFixed(2) !== '27468.50') throw new Error(`${MISFILED} is not the traced entry.`);
  const reversed = await prisma.journalEntry.findFirst({ where: { companyId, reversalOfId: jv.id } });
  if (reversed) throw new Error(`${MISFILED} was already taken out by ${reversed.entryNumber}.`);

  const before = await getAgentStatement({ companyId, agentId: agent.id });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (APPLY) {
    const file = `backups/pre-radouan-links-${stamp}.json`;
    writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), expense, journal: jv, summaryBefore: before.summary }, null, 1));
    console.log(`backup: ${file}`);
  }
  const show = (label: string, s: typeof before.summary) =>
    console.log(
      `${label}: holds ${s.holdingLocal.toFixed(2)} · commission ${s.commissionLocal.toFixed(2)} · loan from him ${s.loanFromAgentLocal.toFixed(2)} · net ${s.netLocal.toFixed(2)} (+ = he owes FID)`,
    );
  show('before', before.summary);

  try {
    await transaction(async () => {
      // 1 — name him on the commission, through the cost's own edit.
      await updateExpense(
        expense.id,
        {
          companyId,
          expenseDate: expense.expenseDate,
          expenseCategoryId: expense.expenseCategoryId,
          shipmentId: expense.shipmentId,
          purchaseContractId: expense.purchaseContractId,
          containerId: expense.containerId,
          batchId: expense.batchId,
          vendorId: null,
          agentId: expense.agentId ?? agent.id,
          payableToAgentId: agent.id,
          currency: expense.currency,
          amount: expense.amount.toString(),
          rateToUsd: expense.rateToUsd.toString(),
          rateLocalPerUsd: expense.rateLocalPerUsd.toString(),
          cashBankAccountId: null,
          paymentMethod: expense.paymentMethod,
          capitaliseToLandedCost: expense.capitaliseToLandedCost,
          allocationMethod: expense.allocationMethod,
          kind: expense.kind,
          taxCodeId: expense.taxCodeId,
          reference: expense.reference,
          description: expense.description,
        },
        admin.id,
      );

      // 2 — the 12 August money is his loan, not collections he handed over:
      // taken out the way the app deletes a voucher (reversed, on the audit
      // trail) and entered again as the loan it was, on the same day.
      const cashLine = jv.lines.find((l) => l.cashBankAccountId);
      if (!cashLine?.cashBankAccountId) throw new Error(`${MISFILED} has no cash line.`);
      await deletePostedEntry({
        companyId,
        userId: admin.id,
        entryId: jv.id,
        reason: 'Corrected — the MAD 27,468.50 of 12 August is a loan from RADOUAN MOHAMMED, not collections handed over; entered again as his loan',
      });
      await postLoan({
        companyId,
        userId: admin.id,
        loanDate: jv.entryDate,
        direction: 'RECEIVED',
        agentId: agent.id,
        cashBankAccountId: cashLine.cashBankAccountId,
        currency: clearingLine.currency,
        amount: clearingLine.credit.toString(),
        description: 'Loan received from RADOUAN MOHAMMED on 12 August',
      });

      const after = await getAgentStatement({ companyId, agentId: agent.id });
      show('after ', after.summary);
      for (const e of after.events) {
        console.log(
          `  ${e.date.toISOString().slice(0, 10)} ${e.documentNumber ?? ''} ${e.journalNumber} | ${e.typeLabel} | ${e.shipment?.reference ?? '-'} | ${e.currency} ${e.amount.toFixed(2)} | owes FID ${e.receivableChangeLocal.toFixed(2)} | FID owes ${e.payableChangeLocal.toFixed(2)} | running ${e.runningNetLocal.toFixed(2)} | ${e.status}`,
        );
      }
      if (!after.summary.netLocal.minus(before.summary.netLocal).abs().lessThan('0.01') && !APPLY) {
        console.log('note: net moved by the named commission, as expected (FID now owes him it on his ledger)');
      }
      if (!APPLY) throw new DryRun();
    });
    console.log(APPLY ? 'applied' : 'dry run only — nothing written');
  } catch (error) {
    if (error instanceof DryRun) {
      console.log('dry run only — rolled back, nothing written');
      return;
    }
    throw error;
  }
}

main().finally(() => prisma.$disconnect());
