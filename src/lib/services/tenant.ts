import { randomBytes, randomInt } from 'node:crypto';
import { prisma, transaction } from '@/lib/db';
import { hashPassword, validatePasswordStrength } from '@/lib/auth/password';
import { BusinessRuleError, ConflictError, NotFoundError } from '@/lib/errors';
import { isCurrencyCode } from '@/lib/currencies';
import { countryByName } from '@/lib/countries';
import { isTemplateKey, TEMPLATES } from '@/lib/templates';
import { PLANS } from '@/lib/entitlements';
import { ONBOARDING_KEY, SETTING_KEYS } from '@/lib/constants';
import { provisionCompany } from '@/lib/services/chart-of-accounts';
import { writeAudit } from '@/lib/services/audit';
import { forgetOrganizationCount } from '@/lib/org-count';

/**
 * Creating and administering customers (tenants).
 *
 * A tenant is an Organization with at least one Company and an owner. Everything
 * here is called from the platform console by the operator, or by the
 * onboarding wizard for an owner who is already inside their own organization.
 * The operator can create, plan, switch off and re-key a customer — and is
 * given no function here that reads their books.
 */

/** A readable temporary password: three words' worth of characters plus digits, never ambiguous glyphs. */
export function temporaryPassword(): string {
  const letters = 'abcdefghjkmnpqrstuvwxyz';
  const caps = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const pick = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `${pick(caps, 1)}${pick(letters, 5)}-${pick(caps, 1)}${pick(letters, 5)}-${randomInt(100, 999)}`;
}

/** Letters and digits of a name, upper-cased, for a company code. */
function slugOf(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toUpperCase()
    .slice(0, 10);
  return slug || 'CO';
}

export type NewTenant = {
  organizationName: string;
  plan?: string;
  authPolicy?: 'PASSWORD' | 'PIN_AND_PASSWORD';
  company: {
    name: string;
    legalName?: string | null;
    country: string;
    /** Defaults to the country's currency. */
    localCurrency?: string;
    timezone?: string;
    address?: string | null;
    industryTemplate?: string;
    businessType?: string;
    /** Defaults to a code made from the name. */
    code?: string;
  };
  owner: { name: string; email: string; password?: string };
  /** Who is creating it, for the audit trail (the platform operator's user id). */
  actorUserId?: string | null;
};

export async function createTenant(input: NewTenant): Promise<{
  organizationId: string;
  companyId: string;
  ownerUserId: string;
  companyCode: string;
  temporaryPassword: string | null;
}> {
  const plan = input.plan ?? 'GROWTH';
  if (!PLANS[plan]) throw new BusinessRuleError('Choose one of the product plans.');
  const template = input.company.industryTemplate ?? 'GENERAL_TRADING';
  if (!isTemplateKey(template)) throw new BusinessRuleError('Choose one of the industry presets.');

  const country = countryByName(input.company.country);
  const localCurrency = (input.company.localCurrency ?? country?.currency ?? '').toUpperCase();
  if (!isCurrencyCode(localCurrency)) throw new BusinessRuleError('Choose the currency the company keeps its books in.');
  const timezone = input.company.timezone ?? country?.timezone ?? 'UTC';

  const email = input.owner.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BusinessRuleError('Enter a valid email address for the owner.');
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
    // Same wording whether the address belongs to this customer or another: it is not ours to say.
    throw new ConflictError('That email address cannot be used. Choose another.');
  }

  const generated = input.owner.password ? null : temporaryPassword();
  const password = input.owner.password ?? generated!;
  const weakness = validatePasswordStrength(password);
  if (weakness) throw new BusinessRuleError(weakness);

  // A short random suffix keeps codes unique across the whole platform without ever
  // revealing that a similar name already has an account.
  let code = (input.company.code?.trim().toUpperCase() || `${slugOf(input.company.name)}-${randomBytes(2).toString('hex').toUpperCase()}`).slice(0, 20);
  if (await prisma.company.findUnique({ where: { code }, select: { id: true } })) {
    code = `${code.slice(0, 15)}-${randomBytes(2).toString('hex').toUpperCase()}`;
  }

  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } });
  const passwordHash = await hashPassword(password);

  const result = await transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: { name: input.organizationName.trim(), plan, authPolicy: input.authPolicy ?? 'PASSWORD' },
    });
    const company = await tx.company.create({
      data: {
        code,
        name: input.company.name.trim(),
        legalName: input.company.legalName?.trim() || input.company.name.trim(),
        country: input.company.country.trim(),
        localCurrency,
        baseCurrency: 'USD',
        timezone,
        address: input.company.address ?? null,
        docPrefix: code,
        organizationId: organization.id,
        industryTemplate: template,
        businessType: input.company.businessType ?? TEMPLATES[template].businessType,
        numberLocale: country?.locale ?? 'en-US',
        dateFormat: country?.dateFormat ?? 'DD MMM YYYY',
        taxLabel: country?.taxLabel ?? 'VAT',
      },
    });
    await provisionCompany(tx, company.id);
    for (const [key, value] of [
      [ONBOARDING_KEY, 'pending'],
      [SETTING_KEYS.ALLOW_NEGATIVE_STOCK, 'false'],
      [SETTING_KEYS.ETA_ALERT_DAYS, '7,3,0'],
      [SETTING_KEYS.DEFAULT_PAYMENT_TERM_DAYS, '30'],
    ] as const) {
      await tx.applicationSetting.create({ data: { companyId: company.id, key, value } });
    }
    const owner = await tx.user.create({
      data: {
        email,
        name: input.owner.name.trim(),
        passwordHash,
        isSuperAdmin: true,
        organizationId: organization.id,
        mustChangePassword: generated !== null,
        defaultCompanyId: company.id,
        roles: { create: { roleId: role.id } },
        companies: { create: { companyId: company.id } },
      },
    });
    await writeAudit(tx, {
      companyId: company.id,
      userId: input.actorUserId ?? owner.id,
      action: 'TENANT_CREATED',
      entityType: 'Organization',
      entityId: organization.id,
      after: { organization: organization.name, plan, company: company.name, code, template, localCurrency, country: input.company.country },
    });
    return { organizationId: organization.id, companyId: company.id, ownerUserId: owner.id };
  }, 120_000);

  forgetOrganizationCount();
  return { ...result, companyCode: code, temporaryPassword: generated };
}

// ---------------------------------------------------------------------------
// Operator actions on an existing customer
// ---------------------------------------------------------------------------

export async function setOrganizationStatus(params: { organizationId: string; active: boolean; actorUserId: string }) {
  const org = await prisma.organization.findUnique({ where: { id: params.organizationId }, include: { companies: { select: { id: true } } } });
  if (!org) throw new NotFoundError('Customer');
  await transaction(async (tx) => {
    await tx.organization.update({ where: { id: org.id }, data: { status: params.active ? 'ACTIVE' : 'INACTIVE' } });
    if (!params.active) {
      // Switching a customer off signs everyone out at once.
      await tx.session.deleteMany({ where: { user: { organizationId: org.id } } });
    }
    await writeAudit(tx, {
      companyId: org.companies[0]?.id ?? null,
      userId: params.actorUserId,
      action: params.active ? 'TENANT_ACTIVATED' : 'TENANT_DEACTIVATED',
      entityType: 'Organization',
      entityId: org.id,
    });
  });
  forgetOrganizationCount();
}

export async function setOrganizationPlan(params: { organizationId: string; plan: string; actorUserId: string }) {
  if (!PLANS[params.plan]) throw new BusinessRuleError('Choose one of the product plans.');
  const org = await prisma.organization.findUnique({ where: { id: params.organizationId }, include: { companies: { select: { id: true } } } });
  if (!org) throw new NotFoundError('Customer');
  await transaction(async (tx) => {
    await tx.organization.update({ where: { id: org.id }, data: { plan: params.plan } });
    await writeAudit(tx, {
      companyId: org.companies[0]?.id ?? null,
      userId: params.actorUserId,
      action: 'TENANT_PLAN_CHANGED',
      entityType: 'Organization',
      entityId: org.id,
      before: { plan: org.plan },
      after: { plan: params.plan },
    });
  });
}

/** Issues the owner a new temporary password and signs them out everywhere. Returns it once. */
export async function resetOwnerPassword(params: { organizationId: string; actorUserId: string }): Promise<{ email: string; password: string }> {
  const owner = await prisma.user.findFirst({
    where: { organizationId: params.organizationId, isSuperAdmin: true, isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!owner) throw new NotFoundError('Owner');
  const password = temporaryPassword();
  const company = await prisma.company.findFirst({ where: { organizationId: params.organizationId }, select: { id: true } });
  await transaction(async (tx) => {
    await tx.user.update({ where: { id: owner.id }, data: { passwordHash: await hashPassword(password), mustChangePassword: true } });
    await tx.session.deleteMany({ where: { userId: owner.id } });
    await writeAudit(tx, {
      companyId: company?.id ?? null,
      userId: params.actorUserId,
      action: 'TENANT_OWNER_RESET',
      entityType: 'User',
      entityId: owner.id,
    });
  });
  return { email: owner.email, password };
}

/**
 * A further legal entity for an existing customer (a second country, say).
 * It joins the same organization, so its owner can switch between entities; its
 * books, currency, tax and warehouses are entirely its own.
 */
export async function addCompany(params: {
  organizationId: string;
  name: string;
  legalName?: string | null;
  country: string;
  localCurrency?: string;
  industryTemplate?: string;
  address?: string | null;
  code?: string;
  /** Existing users who should reach it (the owner, usually). */
  userIds?: string[];
  actorUserId: string;
}): Promise<{ companyId: string; companyCode: string }> {
  const org = await prisma.organization.findUnique({ where: { id: params.organizationId }, include: { _count: { select: { companies: true } } } });
  if (!org) throw new NotFoundError('Customer');
  const template = params.industryTemplate ?? 'GENERAL_TRADING';
  if (!isTemplateKey(template)) throw new BusinessRuleError('Choose one of the industry presets.');
  const country = countryByName(params.country);
  const localCurrency = (params.localCurrency ?? country?.currency ?? '').toUpperCase();
  if (!isCurrencyCode(localCurrency)) throw new BusinessRuleError('Choose the currency the company keeps its books in.');
  let code = (params.code?.trim().toUpperCase() || `${slugOf(params.name)}-${randomBytes(2).toString('hex').toUpperCase()}`).slice(0, 20);
  if (await prisma.company.findUnique({ where: { code }, select: { id: true } })) code = `${code.slice(0, 15)}-${randomBytes(2).toString('hex').toUpperCase()}`;

  const id = await transaction(async (tx) => {
    const company = await tx.company.create({
      data: {
        code,
        name: params.name.trim(),
        legalName: params.legalName?.trim() || params.name.trim(),
        country: params.country.trim(),
        localCurrency,
        baseCurrency: 'USD',
        timezone: country?.timezone ?? 'UTC',
        address: params.address ?? null,
        docPrefix: code,
        organizationId: org.id,
        industryTemplate: template,
        businessType: TEMPLATES[template].businessType,
        numberLocale: country?.locale ?? 'en-US',
        dateFormat: country?.dateFormat ?? 'DD MMM YYYY',
        taxLabel: country?.taxLabel ?? 'VAT',
      },
    });
    await provisionCompany(tx, company.id);
    for (const [key, value] of [
      [SETTING_KEYS.ALLOW_NEGATIVE_STOCK, 'false'],
      [SETTING_KEYS.ETA_ALERT_DAYS, '7,3,0'],
      [SETTING_KEYS.DEFAULT_PAYMENT_TERM_DAYS, '30'],
    ] as const) {
      await tx.applicationSetting.create({ data: { companyId: company.id, key, value } });
    }
    const owners = params.userIds ?? (await tx.user.findMany({ where: { organizationId: org.id, isSuperAdmin: true }, select: { id: true } })).map((u) => u.id);
    for (const userId of owners) await tx.userCompany.upsert({ where: { userId_companyId: { userId, companyId: company.id } }, update: {}, create: { userId, companyId: company.id } });
    await writeAudit(tx, { companyId: company.id, userId: params.actorUserId, action: 'COMPANY_ADDED', entityType: 'Company', entityId: company.id, after: { name: params.name, code, localCurrency, template } });
    return company.id;
  }, 120_000);
  return { companyId: id, companyCode: code };
}
