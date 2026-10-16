'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma, transaction } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { BusinessRuleError, ConflictError } from '@/lib/errors';
import { isCurrencyCode } from '@/lib/currencies';
import { countryByName } from '@/lib/countries';
import { BUSINESS_TYPES, isTemplateKey } from '@/lib/templates';
import { BASE_UOMS } from '@/lib/uom';
import { hashPassword } from '@/lib/auth/password';
import { assertRolesUsable } from '@/lib/auth/tenant';
import { ONBOARDING_KEY } from '@/lib/services/onboarding';
import { planLimit } from '@/lib/entitlements';
import { createCashBankAccount } from '@/lib/services/chart-of-accounts';
import { enableTax, saveTaxCode } from '@/lib/services/tax';
import { temporaryPassword } from '@/lib/services/tenant';
import { setSetting } from '@/lib/services/settings';
import { writeAudit } from '@/lib/services/audit';
import { runImport, type ImportOutcome } from '@/lib/services/import';
import { IMPORT_KINDS, parseRows, type ImportKind } from '@/lib/import/templates';
import { readUpload } from '@/lib/import/parse';
import { fail, run, type ActionResult } from '@/server/actions/action-utils';

/**
 * The first-run wizard's server side. Every action acts on the active company
 * of the signed-in owner, checks `settings.manage`, and reuses the services the
 * rest of the application uses — the wizard is a guided route through the
 * existing screens, not a second way of writing data.
 */

export async function completeOnboardingAction(): Promise<ActionResult<undefined>> {
  return run(async () => {
    const admin = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    await setSetting(admin.activeCompany.id, ONBOARDING_KEY, 'done');
    revalidatePath('/', 'layout');
    return undefined;
  });
}

// --- Steps 2–5: country, currency, business, industry ----------------------

const basicsSchema = z.object({
  country: z.string().trim().min(2).max(100),
  localCurrency: z.string().trim().toUpperCase().refine(isCurrencyCode, 'Unknown currency.'),
  timezone: z.string().trim().min(2).max(60),
  businessType: z.enum(BUSINESS_TYPES.map((b) => b.value) as [string, ...string[]]),
  industryTemplate: z.string().refine(isTemplateKey, 'Choose an industry preset.'),
  unit: z.string().refine((u) => (BASE_UOMS as readonly string[]).includes(u), 'Choose how stock is counted.'),
});

/**
 * Country, books currency, business type and industry — settable freely only
 * until the first entry is posted, because the currency the books are kept in
 * anchors every figure that follows.
 */
export async function saveBasicsAction(input: z.input<typeof basicsSchema>): Promise<ActionResult<undefined>> {
  return run(async () => {
    const admin = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const data = basicsSchema.parse(input);
    const company = await prisma.company.findUniqueOrThrow({ where: { id: admin.activeCompany.id } });
    const posted = await prisma.journalEntry.count({ where: { companyId: company.id } });
    const country = countryByName(data.country);

    if (posted > 0 && (company.country !== data.country || company.localCurrency !== data.localCurrency)) {
      throw new BusinessRuleError('The country and books currency cannot change once entries have been posted — they anchor every figure.');
    }
    const terminology = { ...(company.terminology as Record<string, string>), unit: data.unit };
    await transaction(async (tx) => {
      await tx.company.update({
        where: { id: company.id },
        data: {
          country: data.country,
          localCurrency: data.localCurrency,
          timezone: data.timezone,
          businessType: data.businessType,
          industryTemplate: data.industryTemplate,
          terminology,
          ...(country && company.country !== data.country
            ? { numberLocale: country.locale, dateFormat: country.dateFormat, taxLabel: country.taxLabel }
            : {}),
        },
      });
      await writeAudit(tx, { companyId: company.id, userId: admin.id, action: 'ONBOARDING_BASICS_SAVED', entityType: 'Company', entityId: company.id, after: data });
    });
    revalidatePath('/', 'layout');
    return undefined;
  });
}

// --- Step 6: warehouses ----------------------------------------------------

const warehouseSchema = z.object({ name: z.string().trim().min(1).max(160), location: z.string().trim().max(200).optional(), port: z.string().trim().max(120).optional() });

export async function addWarehouseAction(input: z.input<typeof warehouseSchema>): Promise<ActionResult<undefined>> {
  return run(async () => {
    const admin = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const data = warehouseSchema.parse(input);
    const companyId = admin.activeCompany.id;
    const org = admin.organizationId ? await prisma.organization.findUnique({ where: { id: admin.organizationId }, select: { plan: true } }) : null;
    const count = await prisma.warehouse.count({ where: { companyId } });
    if (count >= planLimit(org?.plan, 'warehouses')) throw new BusinessRuleError('Your plan does not include another warehouse.');
    if (await prisma.warehouse.findFirst({ where: { companyId, name: { equals: data.name, mode: 'insensitive' } } })) {
      throw new ConflictError(`A warehouse called "${data.name}" already exists.`);
    }
    await prisma.warehouse.create({
      data: {
        companyId,
        code: `WH-${String(count + 1).padStart(3, '0')}-${Date.now().toString(36).slice(-3).toUpperCase()}`,
        name: data.name,
        location: data.location || null,
        port: data.port || null,
        country: admin.activeCompany.country,
        isDefault: count === 0,
      },
    });
    revalidatePath('/warehouses');
    return undefined;
  });
}

// --- Step 7: bank and cash accounts ----------------------------------------

const accountSchema = z.object({
  name: z.string().trim().min(1).max(160),
  accountType: z.enum(['CASH', 'BANK']),
  currency: z.string().trim().toUpperCase().refine(isCurrencyCode, 'Unknown currency.'),
  bankName: z.string().trim().max(160).optional(),
});

export async function addCashBankAccountAction(input: z.input<typeof accountSchema>): Promise<ActionResult<undefined>> {
  return run(async () => {
    const admin = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const data = accountSchema.parse(input);
    const companyId = admin.activeCompany.id;
    const count = await prisma.cashBankAccount.count({ where: { companyId } });
    await createCashBankAccount(
      { companyId, code: `${data.accountType === 'CASH' ? 'CASH' : 'BANK'}-${String(count + 1).padStart(3, '0')}-${data.currency}`, name: data.name, accountType: data.accountType, currency: data.currency, bankName: data.bankName || null },
      admin.id,
    );
    revalidatePath('/finance/cash-bank');
    return undefined;
  });
}

// --- Step 8: taxes -----------------------------------------------------------

const taxSchema = z.object({
  registered: z.boolean(),
  registrationNumber: z.string().trim().max(60).optional(),
  label: z.string().trim().min(1).max(12).optional(),
  periodMonths: z.number().int().refine((n) => [1, 3, 12].includes(n)).optional(),
  /** Rates the company charges — entered by the owner; none is assumed. */
  rates: z.array(z.object({ name: z.string().trim().min(1).max(60), ratePct: z.string().trim().regex(/^\d+(\.\d+)?$/) })).max(10).optional(),
});

export async function saveTaxSetupAction(input: z.input<typeof taxSchema>): Promise<ActionResult<undefined>> {
  return run(async () => {
    const admin = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const data = taxSchema.parse(input);
    const companyId = admin.activeCompany.id;
    if (!data.registered) return undefined;
    await enableTax({ companyId, userId: admin.id, registrationNumber: data.registrationNumber ?? '', label: data.label, periodMonths: data.periodMonths });
    let index = 0;
    for (const rate of data.rates ?? []) {
      index += 1;
      await saveTaxCode(
        { companyId, code: `RATE${index}`, name: rate.name, ratePct: rate.ratePct, treatment: Number(rate.ratePct) === 0 ? 'ZERO_RATED' : 'STANDARD', appliesTo: 'BOTH', isDefault: index === 1 },
        admin.id,
      );
    }
    revalidatePath('/settings/tax');
    return undefined;
  });
}

// --- Step 9: people ----------------------------------------------------------

const inviteSchema = z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().toLowerCase().email(), roleId: z.string().min(1) });

/** Creates a teammate with a one-time temporary password the owner passes on. */
export async function inviteUserAction(input: z.input<typeof inviteSchema>): Promise<ActionResult<{ email: string; password: string }>> {
  return run(async () => {
    const admin = await requirePermission(PERMISSIONS.USERS_MANAGE);
    const data = inviteSchema.parse(input);
    await assertRolesUsable(admin, [data.roleId]);
    const org = admin.organizationId ? await prisma.organization.findUnique({ where: { id: admin.organizationId }, select: { plan: true } }) : null;
    const people = await prisma.user.count({ where: { organizationId: admin.organizationId ?? null } });
    if (people >= planLimit(org?.plan, 'users')) throw new BusinessRuleError('Your plan does not include another user.');
    if (await prisma.user.findUnique({ where: { email: data.email }, select: { id: true } })) {
      throw new ConflictError('That email address cannot be used. Choose another.');
    }
    const password = temporaryPassword();
    await transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: data.email,
          name: data.name,
          passwordHash: await hashPassword(password),
          mustChangePassword: true,
          organizationId: admin.organizationId ?? null,
          defaultCompanyId: admin.activeCompany.id,
          roles: { create: { roleId: data.roleId } },
          companies: { create: { companyId: admin.activeCompany.id } },
        },
      });
      await writeAudit(tx, { companyId: admin.activeCompany.id, userId: admin.id, action: 'USER_INVITED', entityType: 'User', entityId: user.id, after: { name: data.name, roleId: data.roleId } });
    });
    revalidatePath('/admin/users');
    return { email: data.email, password };
  });
}

// --- Step 10: import ---------------------------------------------------------

const MAX_UPLOAD = 4 * 1024 * 1024;

async function readImport(kind: string, formData: FormData) {
  if (!(IMPORT_KINDS as readonly string[]).includes(kind)) throw new BusinessRuleError('Unknown kind of import.');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) throw new BusinessRuleError('Choose a CSV or Excel file first.');
  if (file.size > MAX_UPLOAD) throw new BusinessRuleError('That file is over 4 MB. Split it and import in parts.');
  let table;
  try {
    table = await readUpload({ name: file.name, bytes: await file.arrayBuffer() });
  } catch (error) {
    throw new BusinessRuleError(error instanceof Error ? error.message : 'That file could not be read.');
  }
  const parsed = parseRows(kind as ImportKind, table);
  if (parsed.missing.length > 0) {
    throw new BusinessRuleError(`The file is missing these columns: ${parsed.missing.join(', ')}. Download the template to see the layout.`);
  }
  if (parsed.rows.length === 0) throw new BusinessRuleError('The file has a header but no rows.');
  return { kind: kind as ImportKind, parsed };
}

export type ImportPreview = ImportOutcome & { unknownColumns: string[]; rows: number };

export async function previewImportAction(kind: string, formData: FormData): Promise<ActionResult<ImportPreview>> {
  try {
    const admin = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const { parsed, kind: k } = await readImport(kind, formData);
    const outcome = await runImport({ kind: k, rows: parsed.rows, companyId: admin.activeCompany.id, userId: admin.id, terminology: admin.activeCompany.terminology, dryRun: true });
    return { ok: true, data: { ...outcome, unknownColumns: parsed.unknown, rows: parsed.rows.length } };
  } catch (error) {
    return fail(error);
  }
}

export async function commitImportAction(kind: string, formData: FormData): Promise<ActionResult<ImportOutcome>> {
  try {
    const admin = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const { parsed, kind: k } = await readImport(kind, formData);
    const outcome = await runImport({ kind: k, rows: parsed.rows, companyId: admin.activeCompany.id, userId: admin.id, terminology: admin.activeCompany.terminology, dryRun: false });
    revalidatePath('/', 'layout');
    return { ok: true, data: outcome, message: `${outcome.created} imported${outcome.skipped.length ? `, ${outcome.skipped.length} skipped` : ''}.` };
  } catch (error) {
    return fail(error);
  }
}

