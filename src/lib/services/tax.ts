import type { Tx } from '@/lib/db';
import { prisma, transaction } from '@/lib/db';
import { Decimal, dec, toMoney, convertToUsd } from '@/lib/money';
import { TAX_CODE_SEEDS, TAX_REGIMES, DEFAULT_TAX_REGIME } from '@/lib/constants';
import { BusinessRuleError, ConflictError, NotFoundError } from '@/lib/errors';
import { writeAudit } from '@/lib/services/audit';
import type { TaxAppliesTo, TaxTreatment } from '@prisma/client';

/**
 * Tax: VAT in the UAE, TVA in Morocco.
 *
 * Two rules shape everything here.
 *
 * The first is that tax is *not* a cost. Output tax is money collected on the
 * authority's behalf and owed to them; input tax is money advanced to the
 * authority and reclaimable. Neither belongs in revenue, in cost of sales or —
 * most importantly for a coffee trader — in the landed cost of a batch. So tax
 * is always a separate line on the document and a separate leg in the journal,
 * and the amounts that drive costing are net of it.
 *
 * The second is that a company which is not registered must see no tax at all.
 * `taxEnabled` is false until an administrator enters a registration number,
 * and while it is false every function here returns zero and every tax control
 * on screen stays hidden. A business below the registration threshold should
 * not be nudged into charging tax it has no authority to collect.
 */

export type TaxSettings = {
  enabled: boolean;
  label: string;
  registrationNumber: string | null;
  periodMonths: number;
  standardRatePct: Decimal;
};

export async function getTaxSettings(companyId: string): Promise<TaxSettings> {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { taxEnabled: true, taxLabel: true, taxRegistrationNumber: true, taxPeriodMonths: true, country: true },
  });

  const standard = await prisma.taxCode.findFirst({
    where: { companyId, treatment: 'STANDARD', status: 'ACTIVE' },
    orderBy: [{ isDefault: 'desc' }, { ratePct: 'desc' }],
    select: { ratePct: true },
  });

  return {
    enabled: company.taxEnabled,
    label: company.taxLabel,
    registrationNumber: company.taxRegistrationNumber,
    periodMonths: company.taxPeriodMonths,
    standardRatePct: dec(standard?.ratePct ?? 0),
  };
}

/** The statutory defaults for a country, used when tax is first switched on. */
export function taxRegimeFor(country: string | null | undefined) {
  const name = (country ?? '').trim().toLowerCase();
  if (!name) return DEFAULT_TAX_REGIME;
  // Longest match wins, so "ma" cannot claim "United Arab Emirates".
  const found = TAX_REGIMES.find((regime) =>
    regime.match.some((token) => (token.length <= 2 ? name === token : name.includes(token))),
  );
  return found ?? DEFAULT_TAX_REGIME;
}

/**
 * Creates the standard set of codes for a company. Idempotent, so switching
 * tax off and on again does not duplicate them, and an administrator who has
 * edited a rate keeps their edit.
 */
export async function ensureTaxCodes(tx: Tx, companyId: string, country: string): Promise<void> {
  const regime = taxRegimeFor(country);
  const existing = await tx.taxCode.findMany({ where: { companyId }, select: { code: true } });
  const present = new Set(existing.map((code) => code.code));

  const missing = TAX_CODE_SEEDS.filter((seed) => !present.has(seed.code));
  if (missing.length === 0) return;

  await tx.taxCode.createMany({
    data: missing.map((seed) => ({
      companyId,
      code: seed.code,
      // The standard code carries the country's statutory rate; the rest are nil.
      name: seed.treatment === 'STANDARD' ? `${regime.label} ${regime.standardRatePct}%` : seed.name,
      ratePct: seed.treatment === 'STANDARD' ? new Decimal(regime.standardRatePct) : new Decimal(0),
      treatment: seed.treatment,
      appliesTo: seed.appliesTo,
      isDefault: seed.isDefault ?? false,
      isSystem: true,
    })),
    skipDuplicates: true,
  });
}

export async function enableTax(
  params: { companyId: string; userId: string; registrationNumber: string; label?: string; periodMonths?: number },
) {
  return transaction(async (tx) => {
    const company = await tx.company.findUniqueOrThrow({
      where: { id: params.companyId },
      select: { id: true, country: true, taxEnabled: true },
    });

    const registration = params.registrationNumber.trim();
    if (registration.length < 5) {
      throw new BusinessRuleError(
        'Enter the tax registration number exactly as it appears on the certificate — it is printed on every tax invoice you issue.',
      );
    }

    const regime = taxRegimeFor(company.country);
    await ensureTaxCodes(tx, params.companyId, company.country);

    const updated = await tx.company.update({
      where: { id: params.companyId },
      data: {
        taxEnabled: true,
        taxRegistrationNumber: registration,
        taxLabel: (params.label ?? regime.label).slice(0, 12),
        taxPeriodMonths: params.periodMonths ?? regime.periodMonths,
      },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'TAX_REGISTRATION_ENABLED',
      entityType: 'Company',
      entityId: params.companyId,
      before: { taxEnabled: company.taxEnabled },
      after: { taxEnabled: true, registrationNumber: registration },
    });

    return updated;
  });
}

/**
 * Switching tax off stops new documents carrying it. Documents already posted
 * keep their tax lines: they were correct when issued, and a filed return
 * depends on them.
 */
export async function disableTax(params: { companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const updated = await tx.company.update({
      where: { id: params.companyId },
      data: { taxEnabled: false },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'TAX_REGISTRATION_DISABLED',
      entityType: 'Company',
      entityId: params.companyId,
      after: { taxEnabled: false },
    });

    return updated;
  });
}

export async function listTaxCodes(companyId: string, appliesTo?: 'SALES' | 'PURCHASE') {
  return prisma.taxCode.findMany({
    where: {
      companyId,
      status: 'ACTIVE',
      ...(appliesTo ? { appliesTo: { in: [appliesTo, 'BOTH'] as TaxAppliesTo[] } } : {}),
    },
    orderBy: [{ isDefault: 'desc' }, { ratePct: 'desc' }, { code: 'asc' }],
  });
}

export async function saveTaxCode(
  input: {
    companyId: string;
    id?: string | null;
    code: string;
    name: string;
    ratePct: string | number;
    treatment: TaxTreatment;
    appliesTo: TaxAppliesTo;
    isDefault?: boolean;
  },
  userId: string,
) {
  return transaction(async (tx) => {
    const rate = dec(input.ratePct);
    if (rate.lessThan(0) || rate.greaterThan(100)) {
      throw new BusinessRuleError('A tax rate has to be between 0 and 100 percent.');
    }
    if (input.treatment !== 'STANDARD' && !rate.isZero()) {
      throw new BusinessRuleError(
        'Only a standard-rated code carries a rate. Zero-rated, exempt and out-of-scope supplies charge nothing.',
      );
    }

    const code = input.code.trim().toUpperCase();
    if (!code) throw new BusinessRuleError('A tax code needs a short code, for example STD or ZERO.');

    const data = {
      code,
      name: input.name.trim(),
      ratePct: rate,
      treatment: input.treatment,
      appliesTo: input.appliesTo,
      isDefault: input.isDefault ?? false,
    };

    // Only one default per direction, or the form would have to guess.
    if (data.isDefault) {
      await tx.taxCode.updateMany({
        where: {
          companyId: input.companyId,
          isDefault: true,
          ...(input.id ? { id: { not: input.id } } : {}),
        },
        data: { isDefault: false },
      });
    }

    const saved = input.id
      ? await tx.taxCode.update({
          where: { id: input.id },
          data,
        })
      : await tx.taxCode.create({ data: { companyId: input.companyId, ...data } });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId,
      action: input.id ? 'TAX_CODE_UPDATED' : 'TAX_CODE_CREATED',
      entityType: 'TaxCode',
      entityId: saved.id,
      after: { code: saved.code, ratePct: saved.ratePct.toString() },
    });

    return saved;
  });
}

export async function archiveTaxCode(params: { companyId: string; id: string; userId: string }) {
  return transaction(async (tx) => {
    const code = await tx.taxCode.findFirst({ where: { id: params.id, companyId: params.companyId } });
    if (!code) throw new NotFoundError('Tax code');
    if (code.isSystem) {
      throw new ConflictError('A standard code cannot be removed. Set its rate to zero if it no longer applies.');
    }

    const archived = await tx.taxCode.update({ where: { id: code.id }, data: { status: 'INACTIVE', isDefault: false } });
    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'TAX_CODE_DEACTIVATED',
      entityType: 'TaxCode',
      entityId: code.id,
      before: { code: code.code },
    });
    return archived;
  });
}

// ---------------------------------------------------------------------------
// Calculation
// ---------------------------------------------------------------------------

export type ResolvedTaxCode = {
  id: string | null;
  code: string;
  ratePct: Decimal;
  treatment: TaxTreatment;
};

export const NO_TAX: ResolvedTaxCode = { id: null, code: 'NONE', ratePct: new Decimal(0), treatment: 'OUT_OF_SCOPE' };

/**
 * Resolves the code a document line should use.
 *
 * Returns NO_TAX when the company is not registered, whatever the line asked
 * for — a client cannot make an unregistered company charge tax by posting an
 * id, and an id belonging to another company is never found.
 */
export async function resolveTaxCode(
  tx: Tx,
  params: { companyId: string; taxEnabled: boolean; taxCodeId?: string | null; appliesTo: 'SALES' | 'PURCHASE' },
): Promise<ResolvedTaxCode> {
  if (!params.taxEnabled) return NO_TAX;

  if (params.taxCodeId) {
    const code = await tx.taxCode.findFirst({
      where: { id: params.taxCodeId, companyId: params.companyId, status: 'ACTIVE' },
      select: { id: true, code: true, ratePct: true, treatment: true, appliesTo: true },
    });
    if (!code) throw new NotFoundError('Tax code');
    if (code.appliesTo !== 'BOTH' && code.appliesTo !== params.appliesTo) {
      throw new BusinessRuleError(
        `Tax code ${code.code} cannot be used on a ${params.appliesTo === 'SALES' ? 'sale' : 'purchase'}.`,
      );
    }
    return { id: code.id, code: code.code, ratePct: dec(code.ratePct), treatment: code.treatment };
  }

  const fallback = await tx.taxCode.findFirst({
    where: {
      companyId: params.companyId,
      status: 'ACTIVE',
      isDefault: true,
      appliesTo: { in: [params.appliesTo, 'BOTH'] as TaxAppliesTo[] },
    },
    select: { id: true, code: true, ratePct: true, treatment: true },
  });

  return fallback
    ? { id: fallback.id, code: fallback.code, ratePct: dec(fallback.ratePct), treatment: fallback.treatment }
    : NO_TAX;
}

/**
 * Tax on one line, rounded per line rather than on the document total.
 *
 * Per-line rounding is what an invoice shows and what a customer will check by
 * hand, so the two agree; the document total is the sum of the rounded lines,
 * never a separate rounding of the sum.
 */
export function computeLineTax(params: {
  netAmount: Decimal | string | number;
  ratePct: Decimal | string | number;
  rateToUsd: Decimal | string | number;
  currency: string;
}): { taxAmount: Decimal; taxAmountUsd: Decimal } {
  const net = dec(params.netAmount);
  const rate = dec(params.ratePct);
  if (rate.isZero() || net.isZero()) {
    return { taxAmount: new Decimal(0), taxAmountUsd: new Decimal(0) };
  }
  const taxAmount = toMoney(net.times(rate).dividedBy(100));
  return { taxAmount, taxAmountUsd: convertToUsd(taxAmount, params.rateToUsd, params.currency) };
}
