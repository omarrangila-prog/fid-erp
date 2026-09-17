import type { Tx } from '@/lib/db';
import { prisma, transaction } from '@/lib/db';
import { ACCOUNT_KEYS, EXPENSE_CATEGORY_SEEDS, PORT_SEEDS, REPORT_GROUPS } from '@/lib/constants';
import { toMoney } from '@/lib/money';
import { BusinessRuleError, ConflictError, NotFoundError } from '@/lib/errors';
import { postJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { ensureTaxCodes } from '@/lib/services/tax';
import { getRateDefaults } from '@/lib/services/exchange-rate';
import { writeAudit } from '@/lib/services/audit';
import { resolveJournalAccountKind } from '@/lib/services/journal-account-kind';
import type { AccountType, CashBankAccountType, RecordStatus, SubledgerType } from '@prisma/client';

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
    code: '1300',
    name: 'Advances to Suppliers',
    type: 'ASSET',
    reportGroup: REPORT_GROUPS.CURRENT_ASSET,
    systemKey: ACCOUNT_KEYS.SUPPLIER_ADVANCES,
    subledgerType: 'VENDOR',
  },
  {
    code: '2000',
    name: 'Accounts Payable',
    type: 'LIABILITY',
    reportGroup: REPORT_GROUPS.CURRENT_LIABILITY,
    systemKey: ACCOUNT_KEYS.ACCOUNTS_PAYABLE,
    subledgerType: 'VENDOR',
  },
  {
    code: '2010',
    name: 'Accrued Expenses',
    type: 'LIABILITY',
    reportGroup: REPORT_GROUPS.CURRENT_LIABILITY,
    systemKey: ACCOUNT_KEYS.ACCRUED_EXPENSES,
  },
  {
    /*
     * Money a collection agent is holding on the company's behalf.
     *
     * A customer settles by handing the agent a cheque in the agent's own
     * name. The debt is discharged and the company has not been paid — so the
     * balance moves out of receivables and sits here, per agent, until the
     * agent hands the money over. Recording it as bank would state cash the
     * company does not have.
     */
    code: '1160',
    name: 'Agent Clearing — Collections Held',
    type: 'ASSET',
    reportGroup: REPORT_GROUPS.CURRENT_ASSET,
    systemKey: ACCOUNT_KEYS.AGENT_CLEARING,
    subledgerType: 'AGENT',
  },
  {
    code: '1700',
    name: 'Loan Receivable — Group Company',
    type: 'ASSET',
    reportGroup: REPORT_GROUPS.CURRENT_ASSET,
    systemKey: ACCOUNT_KEYS.INTERCOMPANY_LOAN_RECEIVABLE,
  },
  {
    code: '2200',
    name: 'Loan Payable — Group Company',
    type: 'LIABILITY',
    reportGroup: REPORT_GROUPS.CURRENT_LIABILITY,
    systemKey: ACCOUNT_KEYS.INTERCOMPANY_LOAN_PAYABLE,
  },
  {
    code: '2060',
    name: 'Agent Commission Payable',
    type: 'LIABILITY',
    reportGroup: REPORT_GROUPS.CURRENT_LIABILITY,
    systemKey: ACCOUNT_KEYS.AGENT_COMMISSION_PAYABLE,
    subledgerType: 'AGENT',
  },
  {
    code: '2050',
    name: 'Customer Advances',
    type: 'LIABILITY',
    reportGroup: REPORT_GROUPS.CURRENT_LIABILITY,
    systemKey: ACCOUNT_KEYS.CUSTOMER_ADVANCES,
    subledgerType: 'CUSTOMER',
  },
  {
    code: '1350',
    name: 'VAT Recoverable (Input Tax)',
    type: 'ASSET',
    reportGroup: REPORT_GROUPS.CURRENT_ASSET,
    systemKey: ACCOUNT_KEYS.VAT_INPUT,
  },
  {
    code: '2150',
    name: 'VAT Payable (Output Tax)',
    type: 'LIABILITY',
    reportGroup: REPORT_GROUPS.CURRENT_LIABILITY,
    systemKey: ACCOUNT_KEYS.VAT_OUTPUT,
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
    code: '4090',
    name: 'Sales Returns & Credits',
    type: 'INCOME',
    reportGroup: REPORT_GROUPS.REVENUE,
    systemKey: ACCOUNT_KEYS.SALES_RETURNS,
  },
  {
    code: '5090',
    name: 'Purchase Returns & Credits',
    type: 'EXPENSE',
    reportGroup: REPORT_GROUPS.COGS,
    systemKey: ACCOUNT_KEYS.PURCHASE_RETURNS,
  },
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
        kind: seed.kind,
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
  return transaction((tx) => createCashBankAccountIn(tx, input, userId));
}

/** The body of createCashBankAccount, for a caller already inside a transaction. */
export async function createCashBankAccountIn(
  tx: Tx,
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
  const duplicate = await tx.cashBankAccount.findFirst({
    where: { companyId: input.companyId, code: input.code },
  });
  if (duplicate) throw new ConflictError(`A cash/bank account with code "${input.code}" already exists.`);

  // The next free code in the 10xx series, not count + 1: a deactivated or
  // removed account would otherwise make the next one collide.
  const taken = await tx.account.findMany({
    where: { companyId: input.companyId, code: { startsWith: '10' } },
    select: { code: true },
  });
  const used = new Set(taken.map((a) => a.code));
  let n = 1;
  while (used.has(`10${String(n).padStart(2, '0')}`)) n += 1;
  const glCode = `10${String(n).padStart(2, '0')}`;

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
  // The codes exist from day one so the tax settings screen has something to
  // show, but nothing charges tax until an administrator enters a registration
  // number: a company below the threshold must not be nudged into collecting
  // tax it has no authority to collect.
  await ensureTaxCodes(tx, companyId, company.country);
  await ensurePorts(tx, companyId, company.country);
}

const REPORT_GROUP_FOR_TYPE: Record<AccountType, string[]> = {
  ASSET: [REPORT_GROUPS.CURRENT_ASSET, REPORT_GROUPS.NON_CURRENT_ASSET],
  LIABILITY: [REPORT_GROUPS.CURRENT_LIABILITY, REPORT_GROUPS.NON_CURRENT_LIABILITY],
  EQUITY: [REPORT_GROUPS.EQUITY],
  INCOME: [REPORT_GROUPS.REVENUE, REPORT_GROUPS.OTHER_INCOME],
  EXPENSE: [REPORT_GROUPS.COGS, REPORT_GROUPS.OPERATING, REPORT_GROUPS.OTHER_EXPENSE],
};

export type ChartAccount = {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  reportGroup: string | null;
  systemKey: string | null;
  subledgerType: string;
  isSystem: boolean;
  status: RecordStatus;
  currency: string | null;
  cashBank: { id: string; accountType: CashBankAccountType; currency: string } | null;
  expenseCategory: { id: string; code: string } | null;
  balanceUsd: ReturnType<typeof toMoney>;
  balanceLocal: ReturnType<typeof toMoney>;
};

export type ChartSection = {
  key: string;
  title: string;
  hint: string;
  accounts: ChartAccount[];
};

/**
 * The company's chart, grouped the way an accountant reads it.
 *
 * Missing system heads are created first (idempotent, never deletes). Cash
 * and bank accounts sit in their own section so "Cash in Hand" and "Bank in
 * MAD" are visible as themselves rather than buried in a 10xx code.
 */
export async function getChartOfAccounts(companyId: string, localCurrency: string): Promise<{
  sections: ChartSection[];
  localCurrency: string;
}> {
  await transaction(async (tx) => {
    await ensureChartOfAccounts(tx, companyId);
    await ensureExpenseCategories(tx, companyId);
  });

  const accounts = await prisma.account.findMany({
    where: { companyId },
    orderBy: { code: 'asc' },
    include: {
      cashBankAccounts: { select: { id: true, accountType: true, currency: true }, orderBy: { currency: 'asc' } },
      expenseCategories: { select: { id: true, code: true }, take: 1 },
    },
  });

  // Repair GL heads that lost their currency flag — Cash in Hand (MAD) must
  // keep MAD as its native currency so the ledger never opens as "USD only".
  const repairs = accounts.filter(
    (account) => !account.currency && account.cashBankAccounts.length === 1,
  );
  for (const account of repairs) {
    const currency = account.cashBankAccounts[0].currency;
    await prisma.account.update({ where: { id: account.id }, data: { currency } });
    account.currency = currency;
  }

  const totals = await prisma.journalLine.groupBy({
    by: ['accountId'],
    where: { journalEntry: { companyId, status: 'POSTED' } },
    _sum: { debitUsd: true, creditUsd: true, debitLocal: true, creditLocal: true },
  });
  const byAccount = new Map(totals.map((row) => [row.accountId, row._sum]));

  const rows: ChartAccount[] = accounts.map((account) => {
    const sum = byAccount.get(account.id);
    const debitUsd = toMoney(sum?.debitUsd ?? 0);
    const creditUsd = toMoney(sum?.creditUsd ?? 0);
    const debitLocal = toMoney(sum?.debitLocal ?? 0);
    const creditLocal = toMoney(sum?.creditLocal ?? 0);
    const signed =
      account.type === 'LIABILITY' || account.type === 'EQUITY' || account.type === 'INCOME'
        ? { usd: toMoney(creditUsd.minus(debitUsd)), local: toMoney(creditLocal.minus(debitLocal)) }
        : { usd: toMoney(debitUsd.minus(creditUsd)), local: toMoney(debitLocal.minus(creditLocal)) };

    return {
      id: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      reportGroup: account.reportGroup,
      systemKey: account.systemKey,
      subledgerType: account.subledgerType,
      isSystem: account.isSystem,
      status: account.status,
      currency: account.currency,
      cashBank: (() => {
        const drawer =
          account.cashBankAccounts.find((row) => row.currency === account.currency) ??
          account.cashBankAccounts.find((row) => row.currency !== 'USD') ??
          account.cashBankAccounts[0];
        return drawer
          ? { id: drawer.id, accountType: drawer.accountType, currency: drawer.currency }
          : null;
      })(),
      expenseCategory: account.expenseCategories[0]
        ? { id: account.expenseCategories[0].id, code: account.expenseCategories[0].code }
        : null,
      balanceUsd: signed.usd,
      balanceLocal: signed.local,
    };
  });

  const take = (predicate: (account: ChartAccount) => boolean) => rows.filter(predicate);
  const used = new Set<string>();
  const section = (key: string, title: string, hint: string, predicate: (account: ChartAccount) => boolean): ChartSection => {
    const accountsInSection = take((account) => !used.has(account.id) && predicate(account));
    for (const account of accountsInSection) used.add(account.id);
    return { key, title, hint, accounts: accountsInSection };
  };

  const live = (account: ChartAccount) => account.status === 'ACTIVE';
  const sections = [
    section(
      'cash-bank',
      'Cash & Bank',
      'Cash in Hand, MAD bank accounts, USD accounts and any other drawers or banks.',
      (account) => live(account) && (account.subledgerType === 'CASH_BANK' || Boolean(account.cashBank)),
    ),
    section(
      'assets',
      'Assets',
      'Receivables, inventory, advances to suppliers, recoverable tax.',
      (account) => live(account) && account.type === 'ASSET',
    ),
    section(
      'liabilities',
      'Liabilities',
      'Payables, customer advances, tax payable, cheques issued.',
      (account) => live(account) && account.type === 'LIABILITY',
    ),
    section(
      'equity',
      'Equity',
      'Capital, opening balance equity and retained earnings.',
      (account) => live(account) && account.type === 'EQUITY',
    ),
    section(
      'revenue',
      'Revenue',
      'Sales and other income.',
      (account) => live(account) && account.type === 'INCOME',
    ),
    section(
      'cogs',
      'Cost of Goods Sold',
      'Purchase cost, freight, clearing, duty and other costs of landing the coffee.',
      (account) => live(account) && account.type === 'EXPENSE' && account.reportGroup === REPORT_GROUPS.COGS,
    ),
    section(
      'operating',
      'Operating Expenses',
      'General company expenses: rent, salaries, travel, professional fees.',
      (account) => live(account) && account.type === 'EXPENSE' && account.reportGroup === REPORT_GROUPS.OPERATING,
    ),
    section(
      'other',
      'Other',
      'Exchange gain/loss and any remaining heads.',
      (account) => live(account),
    ),
    section(
      'inactive',
      'Inactive',
      'Hidden from new journals. History that already names them still resolves.',
      (account) => account.status === 'INACTIVE',
    ),
  ].filter((group) => group.accounts.length > 0);

  return { sections, localCurrency };
}

/**
 * A user-created ledger head. System accounts (AR, AP, inventory, sales) are
 * never created this way and cannot be replaced by a custom row of the same
 * code.
 */
export async function createLedgerAccount(input: {
  companyId: string;
  code: string;
  name: string;
  type: AccountType;
  reportGroup?: string | null;
  currency?: string | null;
}) {
  const code = input.code.trim();
  const name = input.name.trim();
  if (!code) throw new BusinessRuleError('Enter an account code.');
  if (!name) throw new BusinessRuleError('Enter an account name.');

  const allowed = REPORT_GROUP_FOR_TYPE[input.type];
  const reportGroup =
    input.reportGroup && allowed.includes(input.reportGroup) ? input.reportGroup : allowed[0];
  const currency = input.currency ? input.currency.trim().toUpperCase() : null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) {
    throw new BusinessRuleError('Use a three-letter currency code such as USD or MAD.');
  }

  return transaction(async (tx) => {
    const duplicate = await tx.account.findFirst({ where: { companyId: input.companyId, code } });
    if (duplicate) throw new ConflictError(`Account code ${code} is already in use.`);

    return tx.account.create({
      data: {
        companyId: input.companyId,
        code,
        name,
        type: input.type,
        reportGroup,
        currency,
        isSystem: false,
        subledgerType: 'NONE',
      },
    });
  });
}

async function nextCodeInSeries(tx: Tx, companyId: string, series: number): Promise<string> {
  const start = String(series);
  const existing = await tx.account.findMany({
    where: { companyId, code: { startsWith: start.slice(0, 2) } },
    select: { code: true },
  });
  const taken = new Set(existing.map((row) => row.code));
  for (let offset = 0; offset < 400; offset += 1) {
    const code = String(series + offset);
    if (!taken.has(code)) return code;
  }
  return `${series}-${Date.now().toString(36).toUpperCase()}`;
}

/**
 * Create a named ledger head from a journal voucher — Ahmed as a current
 * account, a loan, an extra expense head — without leaving the entry.
 *
 * One head, both directions. Debiting Ahmed means Ahmed owes the company;
 * crediting Ahmed means the company owes Ahmed. The net lives on the Balance
 * Sheet. Nothing here posts to the Profit & Loss unless the user picks Income
 * or Expense as the type.
 */
export async function quickCreateJournalAccount(params: {
  companyId: string;
  userId: string;
  name: string;
  kind: string;
  currency: string;
}) {
  const kind = resolveJournalAccountKind(params.kind);
  if (!kind) throw new BusinessRuleError('Choose what kind of account this is.');

  const name = params.name.trim();
  if (!name) throw new BusinessRuleError('Enter the account name.');

  const requested = params.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(requested)) {
    throw new BusinessRuleError('Use a three-letter currency code such as USD or MAD.');
  }

  // A personal or loan account is a running account with one person — Ahmed
  // can hand over dollars one week and dirhams the next — so it holds every
  // currency, each shown on its own in the ledger. It has no fixed currency.
  // A cash or bank head is the opposite: one drawer, one currency, and it
  // needs a real cash/bank record behind it or the cash book cannot see it.
  const fixedCurrency = kind.value === 'PERSONAL' || kind.value === 'LOAN' ? null : requested;

  return transaction(async (tx) => {
    const nameClash = await tx.account.findFirst({
      where: { companyId: params.companyId, name: { equals: name, mode: 'insensitive' }, status: 'ACTIVE' },
      select: { id: true, name: true, code: true },
    });
    if (nameClash) {
      throw new ConflictError(`${nameClash.name} is already on the chart.`);
    }

    if (kind.value === 'CASH_BANK') {
      const drawerCount = await tx.cashBankAccount.count({ where: { companyId: params.companyId } });
      const drawer = await createCashBankAccountIn(
        tx,
        {
          companyId: params.companyId,
          code: `CB-${String(drawerCount + 1).padStart(3, '0')}`,
          name,
          accountType: /bank/i.test(name) ? 'BANK' : 'CASH',
          currency: requested,
        },
        params.userId,
      );
      const head = await tx.account.findUniqueOrThrow({ where: { id: drawer.glAccountId } });
      await writeAudit(tx, {
        companyId: params.companyId,
        userId: params.userId,
        action: 'LEDGER_ACCOUNT_CREATED',
        entityType: 'Account',
        entityId: head.id,
        after: { code: head.code, name, kind: kind.value, currency: requested, cashBankAccountId: drawer.id },
      });
      return head;
    }

    const code = await nextCodeInSeries(tx, params.companyId, kind.series);

    const created = await tx.account.create({
      data: {
        companyId: params.companyId,
        code,
        name,
        type: kind.type,
        reportGroup: kind.reportGroup,
        currency: fixedCurrency,
        isSystem: false,
        subledgerType: 'NONE',
      },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'LEDGER_ACCOUNT_CREATED',
      entityType: 'Account',
      entityId: created.id,
      after: { code, name, kind: kind.value, currency: fixedCurrency, reportGroup: kind.reportGroup },
    });

    return created;
  });
}

/**
 * Rename a head, move it on the statements, or (for a custom head) change its
 * code. Type is frozen after create: flipping an expense into an asset would
 * rewrite every report that already used it.
 */
export async function updateLedgerAccount(input: {
  id: string;
  companyId: string;
  code?: string;
  name: string;
  reportGroup?: string | null;
}) {
  const name = input.name.trim();
  if (!name) throw new BusinessRuleError('Enter an account name.');

  return transaction(async (tx) => {
    const account = await tx.account.findFirst({ where: { id: input.id, companyId: input.companyId } });
    if (!account) throw new NotFoundError('Account');

    const allowed = REPORT_GROUP_FOR_TYPE[account.type];
    const reportGroup =
      input.reportGroup && allowed.includes(input.reportGroup) ? input.reportGroup : account.reportGroup;

    let code = account.code;
    if (input.code && input.code.trim() !== account.code) {
      if (account.isSystem) {
        throw new BusinessRuleError(`${account.name} is a system account, so its code cannot be changed.`);
      }
      code = input.code.trim();
      const duplicate = await tx.account.findFirst({
        where: { companyId: input.companyId, code, NOT: { id: account.id } },
      });
      if (duplicate) throw new ConflictError(`Account code ${code} is already in use.`);
    }

    return tx.account.update({
      where: { id: account.id },
      data: { code, name, reportGroup },
    });
  });
}

/**
 * Hide a custom head from new postings. System accounts, cash/bank drawers and
 * expense-category heads stay: the posting engine and the category screen
 * still need them.
 */
export async function deactivateLedgerAccount(input: { id: string; companyId: string }) {
  return transaction(async (tx) => {
    const account = await tx.account.findFirst({
      where: { id: input.id, companyId: input.companyId },
      include: {
        cashBankAccounts: { select: { id: true, name: true }, take: 1 },
        expenseCategories: { select: { id: true, name: true }, take: 1 },
      },
    });
    if (!account) throw new NotFoundError('Account');
    if (account.status === 'INACTIVE') return account;
    if (account.isSystem || account.systemKey) {
      throw new BusinessRuleError(
        `${account.name} is a system account and cannot be deactivated. Posting depends on it.`,
      );
    }
    if (account.cashBankAccounts[0]) {
      throw new BusinessRuleError(
        `${account.name} is a cash or bank account. Retire it under Cash & Bank, not from the chart.`,
      );
    }
    if (account.expenseCategories[0]) {
      throw new BusinessRuleError(
        `${account.name} belongs to the expense category ${account.expenseCategories[0].name}. Deactivate the category instead.`,
      );
    }

    return tx.account.update({ where: { id: account.id }, data: { status: 'INACTIVE' } });
  });
}

export async function reactivateLedgerAccount(input: { id: string; companyId: string }) {
  return transaction(async (tx) => {
    const account = await tx.account.findFirst({ where: { id: input.id, companyId: input.companyId } });
    if (!account) throw new NotFoundError('Account');
    return tx.account.update({ where: { id: account.id }, data: { status: 'ACTIVE' } });
  });
}

/**
 * Opening balance for one ledger head.
 *
 * Cash and bank keep theirs on the drawer itself, the same way a receipt
 * already reads them. Every other head is a journal against Opening Balance
 * Equity, so the trial balance still balances. Control accounts for
 * customers, suppliers and agents are refused: those openings belong on the
 * party, not on the control.
 */
export async function postAccountOpeningBalance(input: {
  accountId: string;
  companyId: string;
  userId: string;
  amount: string | number;
  asOf: Date;
  currency?: string;
  rateToUsd?: string | number;
  rateLocalPerUsd?: string | number;
}) {
  const amount = toMoney(input.amount);
  if (amount.isZero()) {
    throw new BusinessRuleError('Enter an opening amount.');
  }
  if (amount.isNegative()) {
    throw new BusinessRuleError('An opening balance cannot be negative. Use a journal voucher instead.');
  }

  return transaction(async (tx) => {
    const account = await tx.account.findFirst({
      where: { id: input.accountId, companyId: input.companyId },
      include: { cashBankAccounts: { select: { id: true, name: true, currency: true }, take: 1 } },
    });
    if (!account) throw new NotFoundError('Account');
    if (account.status !== 'ACTIVE') {
      throw new BusinessRuleError(`${account.name} is inactive, so an opening cannot be posted to it.`);
    }

    const cashBank = account.cashBankAccounts[0];
    if (cashBank) {
      await tx.cashBankAccount.update({
        where: { id: cashBank.id },
        data: { openingBalance: amount },
      });
      return { kind: 'cash-bank' as const, accountId: account.id, cashBankAccountId: cashBank.id };
    }

    if (account.subledgerType === 'CUSTOMER' || account.subledgerType === 'VENDOR' || account.subledgerType === 'AGENT') {
      throw new BusinessRuleError(
        `${account.name} is a control account. Set the opening on the customer, supplier or agent, not here.`,
      );
    }
    if (account.systemKey === ACCOUNT_KEYS.OPENING_BALANCE_EQUITY) {
      throw new BusinessRuleError('Opening Balance Equity is the other side of every opening. It cannot have one of its own.');
    }

    const already = await tx.journalLine.findFirst({
      where: {
        accountId: account.id,
        journalEntry: { companyId: input.companyId, sourceType: 'OPENING_BALANCE', status: 'POSTED' },
      },
      select: { id: true },
    });
    if (already) {
      throw new BusinessRuleError(
        `${account.name} already has an opening balance. Reverse that journal if the figure was wrong.`,
      );
    }

    const company = await getCompanyContext(tx, input.companyId);
    const currency = (input.currency ?? company.localCurrency).toUpperCase();
    const rates = await getRateDefaults(input.companyId, input.asOf);
    const rateToUsd = input.rateToUsd ?? (currency === 'USD' ? '1' : rates.byCurrency[currency] ?? rates.local);
    const rateLocalPerUsd =
      input.rateLocalPerUsd ?? (currency === company.localCurrency.toUpperCase() ? rateToUsd : rates.local);

    const debitNormal = account.type === 'ASSET' || account.type === 'EXPENSE';

    await postJournalEntry(tx, {
      companyId: input.companyId,
      entryDate: input.asOf,
      description: `Opening balance — ${account.code} ${account.name}`,
      sourceType: 'OPENING_BALANCE',
      sourceId: account.id,
      createdById: input.userId,
      localCurrency: company.localCurrency,
      rateLocalPerUsd,
      lines: [
        {
          accountId: account.id,
          direction: debitNormal ? 'DEBIT' : 'CREDIT',
          currency,
          amount,
          rateToUsd,
          description: 'Opening balance',
        },
        {
          accountKey: ACCOUNT_KEYS.OPENING_BALANCE_EQUITY,
          direction: debitNormal ? 'CREDIT' : 'DEBIT',
          currency,
          amount,
          rateToUsd,
          description: `Opening — ${account.name}`,
        },
      ],
    });

    return { kind: 'journal' as const, accountId: account.id };
  });
}

/**
 * The ports this company plausibly ships through: its own, plus the origins
 * coffee comes from. Idempotent, and an administrator can add or retire any of
 * them — this only makes the picker useful before anyone has typed anything.
 */
export async function ensurePorts(tx: Tx, companyId: string, country: string): Promise<void> {
  const name = (country ?? '').toLowerCase();
  const home = name.includes('emirat') || name.includes('uae') || name.includes('dubai')
    ? PORT_SEEDS.AE
    : name.includes('morocco') || name.includes('maroc')
      ? PORT_SEEDS.MA
      : [];

  const wanted = [...home, ...PORT_SEEDS.ORIGIN];
  const existing = await tx.port.findMany({ where: { companyId }, select: { code: true } });
  const present = new Set(existing.map((port) => port.code));

  const missing = wanted.filter((port) => !present.has(port.code));
  if (missing.length === 0) return;

  await tx.port.createMany({
    data: missing.map((port) => ({ companyId, ...port })),
    skipDuplicates: true,
  });
}
