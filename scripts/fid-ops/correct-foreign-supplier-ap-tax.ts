import 'dotenv/config';
import { prisma, transaction } from '@/lib/db';
import { dec, toMoney } from '@/lib/money';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { postJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { writeAudit } from '@/lib/services/audit';
import { supplierInvoiceIncludesInputTax } from '@/lib/services/tax';
import { assertPeriodOpen } from '@/lib/services/period';

/**
 * Takes import VAT/TVA off a foreign supplier's payable.
 *
 * The original PO posting credited AP with goods + the buying company's
 * statutory tax. A Ugandan (or other foreign) exporter does not invoice that
 * tax, so the supplier ledger was overstated. This posts Dr AP / Cr VAT_INPUT
 * for the tax amount and zeros the tax stored on the contract, without
 * reversing the purchase or the goods receipt.
 *
 * Idempotent: a MANUAL journal keyed `ap-import-tax-correction:<id>` is posted
 * once per document.
 */

const SOURCE_PREFIX = 'ap-import-tax-correction:';

function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function main() {
  const admin = await prisma.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } });

  const contracts = await prisma.purchaseContract.findMany({
    where: { status: 'POSTED' },
    include: {
      vendor: { select: { vendorName: true, country: true } },
      company: { select: { country: true, code: true, localCurrency: true } },
    },
  });

  const targets = contracts.filter(
    (contract) =>
      dec(contract.taxAmount).greaterThan(0) &&
      !supplierInvoiceIncludesInputTax(contract.vendor.country, contract.company.country),
  );

  if (targets.length === 0) {
    console.log('No foreign-supplier contracts still carrying input tax on the payable.');
    return;
  }

  for (const contract of targets) {
    const extra = toMoney(contract.taxAmount);
    const sourceId = `${SOURCE_PREFIX}${contract.id}`;
    const existing = await prisma.journalEntry.findFirst({
      where: { companyId: contract.companyId, sourceType: 'MANUAL', sourceId },
      select: { entryNumber: true },
    });
    if (existing) {
      console.log(`${contract.contractNumber}: already corrected as ${existing.entryNumber}`);
      continue;
    }

    await transaction(async (tx) => {
      const company = await getCompanyContext(tx, contract.companyId);
      let entryDate = contract.contractDate;
      try {
        await assertPeriodOpen(tx, contract.companyId, entryDate);
      } catch (error) {
        if (!(error instanceof Error) || !/period up to .* is closed/i.test(error.message)) throw error;
        entryDate = todayUtc();
      }

      await postJournalEntry(tx, {
        companyId: contract.companyId,
        entryDate,
        description: `Remove import tax from supplier ${contract.vendor.vendorName} on ${contract.contractNumber}`,
        sourceType: 'MANUAL',
        sourceId,
        createdById: admin.id,
        localCurrency: company.localCurrency,
        rateLocalPerUsd: contract.rateLocalPerUsd,
        lines: [
          {
            accountKey: ACCOUNT_KEYS.ACCOUNTS_PAYABLE,
            direction: 'DEBIT',
            currency: contract.currency,
            amount: extra,
            rateToUsd: contract.rateToUsd,
            description: `Tax was not billed by ${contract.vendor.vendorName}`,
            vendorId: contract.vendorId,
            purchaseContractId: contract.id,
          },
          {
            accountKey: ACCOUNT_KEYS.VAT_INPUT,
            direction: 'CREDIT',
            currency: contract.currency,
            amount: extra,
            rateToUsd: contract.rateToUsd,
            description: `Unwind input tax that was not on the supplier invoice`,
            purchaseContractId: contract.id,
          },
        ],
      });

      await tx.purchaseContract.update({
        where: { id: contract.id },
        data: { taxAmount: 0, taxAmountUsd: 0 },
      });
      await tx.purchaseContractLine.updateMany({
        where: { purchaseContractId: contract.id },
        data: { taxAmount: 0, taxAmountUsd: 0, taxRatePct: 0, taxCodeId: null },
      });

      await writeAudit(tx, {
        companyId: contract.companyId,
        userId: admin.id,
        action: 'PURCHASE_CONTRACT_IMPORT_TAX_CORRECTED',
        entityType: 'PurchaseContract',
        entityId: contract.id,
        before: { taxAmount: contract.taxAmount.toString(), payableWithTax: extra.plus(contract.totalValue).toString() },
        after: { taxAmount: '0', payable: contract.totalValue.toString() },
      });
    });

    console.log(
      `${contract.company.code} ${contract.contractNumber}: AP reduced by ${extra.toString()} ${contract.currency} (now ${contract.totalValue.toString()})`,
    );
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
