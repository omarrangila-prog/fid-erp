import type { Tx } from '@/lib/db';
import { transaction } from '@/lib/db';
import { ACCOUNT_KEYS, EXPENSE_CATEGORY_SEEDS, REPORT_GROUPS } from '@/lib/constants';
import { toMoney } from '@/lib/money';
import { BusinessRuleError, ConflictError, NotFoundError } from '@/lib/errors';
import { postJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import type { AccountType, CashBankAccountType, SubledgerType } from '@prisma/client';

/**
 * Company provisioning: the chart of accounts, the standard expense categories
 * and the cash/bank accounts that sit on top of the general ledger.
 *
 * The chart is deliberately compact — the aim is QuickBooks-level familiarity,
 * not a thousand-line statutory chart. Control accounts carry a `systemKey` so
 * the posting engine can find them without hard-coded account codes, a
 * `subledgerType` so customer/supplier/cash balances can be derived from the
 * journal by party, and a `reportGroup` that drives where they land in the
 * Profit & Loss and the Balance Sheet.
 */

type AccountSeed = {
  code: string;
  name: string;
  type: AccountType;
  reportGroup: string;
  systemKey?: string;
  subledgerType?: SubledgerType;
};

const STANDARD_ACCOUNTS: AccountSeed[] = [
  // --- Assets --------------------------------------------------------------
  {
    code: '1100',
    name: 'Accounts Receivable',
    type: 'ASSET',
    reportGroup: REPORT_GROUPS.CURRENT_ASSET,
    systemKey: ACCOUNT_KEYS.ACCOUNTS_RECEIVABLE,
    subledgerType: 'CUSTOMER',
  },
  {
    code: '1150',
    name: 'Cheques on Hand',
    type: 'ASSET',
    reportGroup: REPORT_GROUPS.CURRENT_ASSET,
    systemKey: ACCOUNT_KEYS.CHEQUES_ON_HAND,
  },
  {
    code: '1200',
    name: 'Inventory — Coffee Stock',
    type: 'ASSET',
    reportGroup: REPORT_GROUPS.CURRENT_ASSET,
    systemKey: ACCOUNT_KEYS.INVENTORY,
  },
  {
    code: '1250',
    name: 'Inventory in Transit',
    type: 'ASSET',
    reportGroup: REPORT_GROUPS.CURRENT_ASSET,
    systemKey: ACCOUNT_KEYS.INVENTORY_IN_TRANSIT,
  },
  // --- Liabilities ---------------------------------------------------------
  {
    code: '2000',
    name: 'Accounts Payable',
    type: 'LIABILITY',
    reportGroup: REPORT_GROUPS.CURRENT_LIABILITY,
    systemKey: ACCOUNT_KEYS.ACCOUNTS_PAYABLE,
    subledgerType: 'VENDOR',
  },
  {
    code: '2100',
    name: 'Cheques Issued — Not Cleared',
    type: 'LIABILITY',
    reportGroup: REPORT_GROUPS.CURRENT_LIABILITY,
    systemKey: ACCOUNT_KEYS.CHEQUES_ISSUED,
  },
  // --- Equity --------------------------------------------------------------
  {
    code: '3000',
    name: 'Opening Balance Equity',
    type: 'EQUITY',
    reportGroup: REPORT_GROUPS.EQUITY,
    systemKey: ACCOUNT_KEYS.OPENING_BALANCE_EQUITY,
  },
  {
    code: '3100',
    name: 'Retained Earnings',
    type: 'EQUITY',
    reportGroup: REPORT_GROUPS.EQUITY,
    systemKey: ACCOUNT_KEYS.RETAINED_EARNINGS,
  },
  // --- Income --------------------------------------------------------------
  {
    code: '4000',
    name: 'Coffee Sales',
    type: 'INCOME',
    reportGroup: REPORT_GROUPS.REVENUE,
    systemKey: ACCOUNT_KEYS.SALES_REVENUE,
  },
  // --- Cost of sales -------------------------------------------------------
  {
    code: '5000',
    name: 'Cost of Goods Sold',
    type: 'EXPENSE',
    reportGroup: REPORT_GROUPS.COGS,
    systemKey: ACCOUNT_KEYS.COST_OF_GOODS_SOLD,
  },
  {
    code: '5100',
    name: 'Freight and Logistics',
    type: 'EXPENSE',
    reportGroup: REPORT_GROUPS.COGS,
    systemKey: ACCOUNT_KEYS.FREIGHT_COST,
  },
  {
    code: '5900',
    name: 'Inventory Adjustments',
    type: 'EXPENSE',
    reportGroup: REPORT_GROUPS.COGS,
    systemKey: ACCOUNT_KEYS.INVENTORY_ADJUSTMENT,
  },
  // --- Operating expenses --------------------------------------------------
  {
    code: '6000',
    name: 'General Operating Expenses',
    type: 'EXPENSE',
    reportGroup: REPORT_GROUPS.OPERATING,
    systemKey: ACCOUNT_KEYS.EXPENSE_DEFAULT,
  },
  {
    code: '6900',
    name: 'Foreign Exchange Gain / Loss',
    type: 'EXPENSE',
    reportGroup: REPORT_GROUPS.OTHER_EXPENSE,
    systemKey: ACCOUNT_KEYS.FX_GAIN_LOSS,
  },
];

export async function ensureChartOfAccounts(tx: Tx, companyId: string): Promise<void> {
  // One read and one write. The obvious version — look up each account, then
  // create it — costs a network round-trip per row, which is imperceptible
  // against a local database and takes tens of seconds against a hosted one.
  const existing = await tx.account.findMany({ where: { companyId }, select: { code: true } });
  const present = new Set(existing.map((account) => account.code));

  const missing = STANDARD_ACCOUNTS.filter((seed) => !present.has(seed.code));
  if (missing.length === 0) return;

  await tx.account.createMany({
    data: missing.map((seed) => ({
      companyId,
      code: seed.code,
      name: seed.name,
      type: seed.type,
      reportGroup: seed.reportGroup,
      systemKey: seed.systemKey ?? null,
      subledgerType: seed.subledgerType ?? 'NONE',
      isSystem: true,
    })),
    skipDuplicates: true,
  });
}

/**
 * Creates the standard expense categories, each with its own GL account so
 * "Expenses by Category" is a straight ledger query. Direct shipment costs are
 * flagged to capitalise into landed cost; period costs are not.
 */
export async function ensureExpenseCategories(tx: Tx, companyId: string): Promise<void> {
  // The GL code comes from the seed's position in the catalogue, not from its
  // position among the ones still missing, so re-running against a partly
  // provisioned company reuses the same codes instead of colliding.
  let capitalisedSeq = 1;
  let operatingSeq = 1;
  const planned = EXPENSE_CATEGORY_SEEDS.map((seed) => ({
    ...seed,
    // Capitalised costs sit in the 52xx cost-of-sales range; period costs in 61xx.
    glCode: seed.capitalise
      ? `52${String(capitalisedSeq++).padStart(2, '0')}`
      : `61${String(operatingSeq++).padStart(2, '0')}`,
  }));

  const [existingCategories, existingAccounts] = await Promise.all([
    tx.expenseCategory.findMany({ where: { companyId }, select: { code: true } }),
    tx.account.findMany({ where: { companyId }, select: { id: true, code: true } }),
  ]);

  const presentCategories = new Set(existingCategories.map((category) => category.code));
  const accountIdByCode = new Map(existingAccounts.map((account) => [account.code, account.id]));

  const missing = planned.filter((seed) => !presentCategories.has(seed.code));
  if (missing.length === 0) return;

  const missingAccounts = missing.filter((seed) => !accountIdByCode.has(seed.glCode));
  if (missingAccounts.length > 0) {
    await tx.account.createMany({
      data: missingAccounts.map((seed) => ({
        companyId,
        code: seed.glCode,
        name: seed.name,
        type: 'EXPENSE' as const,
        reportGroup: seed.capitalise ? REPORT_GROUPS.COGS : REPORT_GROUPS.OPERATING,
        isSystem: true,
      })),
      skipDuplicates: true,
    });

    // createMany does not return rows, and the categories need the ids.
    const created = await tx.account.findMany({
      where: { companyId, code: { in: missingAccounts.map((seed) => seed.glCode) } },
      select: { id: true, code: true },
    });
    for (const account of created) accountIdByCode.set(account.code, account.id);
  }

  await tx.expenseCategory.createMany({
    data: missing.map((seed) => {
      const glAccountId = accountIdByCode.get(seed.glCode);
      if (!glAccountId) {
        throw new BusinessRuleError(`No GL account ${seed.glCode} for expense category ${seed.code}.`);
      }
      return {
        companyId,
        code: seed.code,
        name: seed.name,
        glAccountId,
        capitaliseByDefault: seed.capitalise,
      };
    }),
    skipDuplicates: true,
  });
}

/**
 * Creates a cash, petty cash or bank account together with its backing GL
 * account. Balances are always derived from journal lines plus the opening
 * balance and can never be edited directly.
 */
export async function createCashBankAccount(
  input: {
    companyId: string;
    code: string;
    name: string;
    accountType: CashBankAccountType;
    currency: string;
    openingBalance?: string | number;
    bankName?: string | null;
    accountNumber?: string | null;
  },
  userId: string,
) {
  return transaction(async (tx) => {
    const duplicate = await tx.cashBankAccount.findFirst({
      where: { companyId: input.companyId, code: input.code },
    });
    if (duplicate) throw new ConflictError(`A cash/bank account with code "${input.code}" already exists.`);

    const glCount = await tx.account.count({ where: { companyId: input.companyId, code: { startsWith: '10' } } });
    const glCode = `10${String(glCount + 1).padStart(2, '0')}`;

    const glAccount = await tx.account.create({
      data: {
        companyId: input.companyId,
        code: glCode,
        name: `${input.name} (${input.currency.toUpperCase()})`,
        type: 'ASSET',
        reportGroup: REPORT_GROUPS.CURRENT_ASSET,
        subledgerType: 'CASH_BANK',
        currency: input.currency.toUpperCase(),
        isSystem: true,
      },
    });

    const account = await tx.cashBankAccount.create({
      data: {
        companyId: input.companyId,
        code: input.code,
        name: input.name,
        accountType: input.accountType,
        currency: input.currency.toUpperCase(),
        openingBalance: toMoney(input.openingBalance ?? 0),
        bankName: input.bankName ?? null,
        accountNumber: input.accountNumber ?? null,
        glAccountId: glAccount.id,
      },
    });

    void userId;
    return account;
  });
}

/**
 * Posts a party's opening balance through the normal journal so it appears in
 * the ledger like any other transaction rather than as an untraceable
 * adjustment.
 */
export async function postOpeningBalance(
  tx: Tx,
  params: {
    companyId: string;
    party: { type: 'CUSTOMER' | 'VENDOR'; id: string; name: string };
    currency: string;
    amount: string | number;
    rateToUsd: string | number;
    rateLocalPerUsd: string | number;
    asOf: Date;
    userId: string;
  },
): Promise<void> {
  const amount = toMoney(params.amount);
  if (amount.isZero()) return;
  if (amount.isNegative()) {
    throw new BusinessRuleError('An opening balance cannot be negative. Use a credit note instead.');
  }

  const company = await getCompanyContext(tx, params.companyId);
  const isCustomer = params.party.type === 'CUSTOMER';

  await postJournalEntry(tx, {
    companyId: params.companyId,
    entryDate: params.asOf,
    description: `Opening balance — ${params.party.name}`,
    sourceType: 'OPENING_BALANCE',
    sourceId: params.party.id,
    createdById: params.userId,
    localCurrency: company.localCurrency,
    rateLocalPerUsd: params.rateLocalPerUsd,
    lines: [
      {
        accountKey: isCustomer ? ACCOUNT_KEYS.ACCOUNTS_RECEIVABLE : ACCOUNT_KEYS.OPENING_BALANCE_EQUITY,
        direction: 'DEBIT',
        currency: params.currency,
        amount,
        rateToUsd: params.rateToUsd,
        description: 'Opening balance',
        ...(isCustomer ? { customerId: params.party.id } : {}),
      },
      {
        accountKey: isCustomer ? ACCOUNT_KEYS.OPENING_BALANCE_EQUITY : ACCOUNT_KEYS.ACCOUNTS_PAYABLE,
        direction: 'CREDIT',
        currency: params.currency,
        amount,
        rateToUsd: params.rateToUsd,
        description: 'Opening balance',
        ...(isCustomer ? {} : { vendorId: params.party.id }),
      },
    ],
  });
}

/** Full provisioning for a new company. Safe to re-run. */
export async function provisionCompany(tx: Tx, companyId: string): Promise<void> {
  const company = await tx.company.findUnique({ where: { id: companyId } });
  if (!company) throw new NotFoundError('Company');
  await ensureChartOfAccounts(tx, companyId);
  await ensureExpenseCategories(tx, companyId);
}
