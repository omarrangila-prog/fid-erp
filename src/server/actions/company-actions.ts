'use server';

import { revalidatePath } from 'next/cache';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma, transaction } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { BusinessRuleError } from '@/lib/errors';
import { isCurrencyCode } from '@/lib/currencies';
import { FEATURES } from '@/lib/features';
import { planAllows } from '@/lib/entitlements';
import { BUSINESS_TYPES, templateFeatureDefaults, isTemplateKey } from '@/lib/templates';
import { DEFAULT_TERMS } from '@/lib/terminology';
import { writeAudit } from '@/lib/services/audit';
import { fail, run, type ActionResult } from '@/server/actions/action-utils';

/**
 * A company's own profile and configuration, edited by its own administrator.
 *
 * Everything here acts on the *active company only* and needs `settings.manage`.
 * The local (accounting) currency is not editable here: it anchors every
 * historical figure and is frozen once anything is posted.
 */

const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD MMM YYYY'] as const;

const clean = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'That is too long.')
    .optional()
    .transform((v) => (v ? v : null));

const profileSchema = z.object({
  name: z.string().trim().min(1, 'Company name is required.').max(160),
  legalName: clean(200),
  tradingName: clean(160),
  tagline: clean(80),
  address: clean(400),
  phone: clean(40),
  email: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid email address.'),
  website: clean(200),
  companyRegistration: clean(60),
  dateFormat: z.enum(DATE_FORMATS),
  numberLocale: z
    .string()
    .trim()
    .refine((v) => {
      try {
        return Intl.getCanonicalLocales(v).length === 1;
      } catch {
        return false;
      }
    }, 'That is not a valid locale such as en-US or de-DE.'),
  timezone: z
    .string()
    .trim()
    .refine((v) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, 'That is not a time zone the system knows.'),
});

export async function saveCompanyProfileAction(formData: FormData): Promise<ActionResult<undefined>> {
  return run(async () => {
    const admin = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const raw = Object.fromEntries(
      ['name', 'legalName', 'tradingName', 'tagline', 'address', 'phone', 'email', 'website', 'companyRegistration', 'dateFormat', 'numberLocale', 'timezone'].map(
        (k) => [k, formData.get(k) ?? undefined],
      ),
    );
    const input = profileSchema.parse(raw);
    const companyId = admin.activeCompany.id;
    const before = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    await prisma.company.update({ where: { id: companyId }, data: input });
    await transaction((tx) =>
      writeAudit(tx, {
        companyId,
        userId: admin.id,
        action: 'COMPANY_PROFILE_UPDATED',
        entityType: 'Company',
        entityId: companyId,
        before: pick(before, Object.keys(input)),
        after: input,
      }),
    );
    revalidatePath('/', 'layout');
    return undefined;
  });
}

function pick(row: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, row[k]]));
}

// ---------------------------------------------------------------------------
// Configuration: currencies, modules, words, industry
// ---------------------------------------------------------------------------

const TERM_KEYS = Object.keys(DEFAULT_TERMS) as Array<keyof typeof DEFAULT_TERMS>;

const configSchema = z.object({
  industryTemplate: z.string().refine(isTemplateKey, 'Choose one of the industry presets.'),
  businessType: z.enum(BUSINESS_TYPES.map((b) => b.value) as [string, ...string[]]),
  transactionCurrencies: z.array(z.string().toUpperCase().refine(isCurrencyCode, 'Unknown currency.')).max(40),
  salesCurrencies: z.array(z.string().toUpperCase().refine(isCurrencyCode, 'Unknown currency.')).max(40),
  defaultSalesCurrency: z
    .string()
    .toUpperCase()
    .nullable()
    .refine((v) => v === null || v === '' || isCurrencyCode(v), 'Unknown currency.'),
  features: z.record(z.string(), z.boolean()),
  terminology: z.record(z.string(), z.string().trim().max(40)),
  fxCostPolicy: z.enum(['RECOST_ALL', 'NONE']),
});

export type CompanyConfigInput = z.input<typeof configSchema>;

export async function saveCompanyConfigAction(payload: CompanyConfigInput): Promise<ActionResult<undefined>> {
  return run(async () => {
    const admin = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const input = configSchema.parse(payload);
    const company = await prisma.company.findUniqueOrThrow({
      where: { id: admin.activeCompany.id },
      include: { organization: { select: { plan: true } } },
    });
    const plan = company.organization?.plan ?? 'ENTERPRISE';

    const local = company.localCurrency.toUpperCase();
    const transaction_ = [...new Set(input.transactionCurrencies)];
    const sales = [...new Set(input.salesCurrencies)];
    const allowedForSale = new Set([...transaction_, local]);
    if (sales.some((c) => !allowedForSale.has(c))) {
      throw new BusinessRuleError('A currency you invoice in must also be one the company transacts in.');
    }
    const defaultSales = input.defaultSalesCurrency ? input.defaultSalesCurrency : null;
    if (defaultSales && ![...(sales.length ? sales : transaction_), local].includes(defaultSales)) {
      throw new BusinessRuleError('The default sales currency must be one of the currencies you invoice in.');
    }

    // Store only the switches that differ from the template's own defaults, and
    // never switch on what the plan does not include.
    const defaults = templateFeatureDefaults(input.industryTemplate);
    const overrides: Record<string, boolean> = {};
    for (const feature of FEATURES) {
      const wanted = input.features[feature];
      if (typeof wanted !== 'boolean') continue;
      if (wanted && !planAllows(plan, feature)) continue;
      const base = defaults[feature] ?? true;
      if (wanted !== base) overrides[feature] = wanted;
    }

    const terminology: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.terminology)) {
      if (!TERM_KEYS.includes(key as never)) continue;
      if (value && value !== DEFAULT_TERMS[key as keyof typeof DEFAULT_TERMS]) terminology[key] = value;
    }

    await prisma.company.update({
      where: { id: company.id },
      data: {
        industryTemplate: input.industryTemplate,
        businessType: input.businessType,
        transactionCurrencies: transaction_,
        salesCurrencies: sales,
        defaultSalesCurrency: defaultSales,
        features: overrides,
        terminology,
        fxCostPolicy: input.fxCostPolicy,
      },
    });
    await transaction((tx) =>
      writeAudit(tx, {
        companyId: company.id,
        userId: admin.id,
        action: 'COMPANY_CONFIG_UPDATED',
        entityType: 'Company',
        entityId: company.id,
        before: {
          industryTemplate: company.industryTemplate,
          transactionCurrencies: company.transactionCurrencies,
          salesCurrencies: company.salesCurrencies,
          features: company.features,
          terminology: company.terminology,
          fxCostPolicy: company.fxCostPolicy,
        },
        after: { ...input, features: overrides, terminology },
      }),
    );
    revalidatePath('/', 'layout');
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

const LOGO_MAX_BYTES = 512 * 1024;

/** What the bytes actually are — never trust the file name or the declared type. */
function sniffImage(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (bytes.length > 12 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length > 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return null;
}

export async function uploadCompanyLogoAction(formData: FormData): Promise<ActionResult<undefined>> {
  try {
    const admin = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const file = formData.get('logo');
    if (!(file instanceof File) || file.size === 0) throw new BusinessRuleError('Choose an image file first.');
    if (file.size > LOGO_MAX_BYTES) throw new BusinessRuleError('The logo must be under 512 KB. Resize it and try again.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = sniffImage(bytes);
    if (!mime) throw new BusinessRuleError('The logo must be a PNG, JPEG or WebP image. (SVG is not accepted.)');

    const companyId = admin.activeCompany.id;
    await transaction(async (tx) => {
      await tx.companyLogo.upsert({
        where: { companyId },
        update: { mimeType: mime, bytes },
        create: { companyId, mimeType: mime, bytes },
      });
      await tx.company.update({ where: { id: companyId }, data: { logoUpdatedAt: new Date() } });
      await writeAudit(tx, {
        companyId,
        userId: admin.id,
        action: 'COMPANY_LOGO_UPDATED',
        entityType: 'Company',
        entityId: companyId,
        after: { mime, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      });
    });
    revalidatePath('/', 'layout');
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function removeCompanyLogoAction(): Promise<ActionResult<undefined>> {
  return run(async () => {
    const admin = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const companyId = admin.activeCompany.id;
    await transaction(async (tx) => {
      await tx.companyLogo.deleteMany({ where: { companyId } });
      await tx.company.update({ where: { id: companyId }, data: { logoUpdatedAt: null } });
      await writeAudit(tx, { companyId, userId: admin.id, action: 'COMPANY_LOGO_REMOVED', entityType: 'Company', entityId: companyId });
    });
    revalidatePath('/', 'layout');
    return undefined;
  });
}

