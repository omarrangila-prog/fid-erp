import { z } from 'zod';

/**
 * Shared Zod primitives.
 *
 * Money and quantity arrive from forms as strings and stay strings all the way
 * to the Decimal layer — parsing them into JavaScript numbers on the way past
 * would defeat the entire point of the decimal arithmetic.
 */

export const decimalString = (label: string, options?: { min?: number; allowZero?: boolean }) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .refine((v) => /^-?\d+(\.\d+)?$/.test(v), `${label} must be a number.`)
    .refine((v) => {
      const n = Number(v);
      if (options?.min !== undefined) return n >= options.min;
      return options?.allowZero ? n >= 0 : n > 0;
    }, options?.allowZero ? `${label} cannot be negative.` : `${label} must be greater than zero.`);

/**
 * Optional really means optional.
 *
 * These used to require the key to be present, even if empty — fine while
 * every form posted every field, and a trap the moment one stopped. A field
 * the caller omits entirely now lands on the same value as one left blank.
 */
export const optionalDecimalString = (label: string, options?: { allowNegative?: boolean }) =>
  z
    .string()
    .trim()
    .refine((v) => v === '' || /^-?\d+(\.\d+)?$/.test(v), `${label} must be a number.`)
    // A negative freight, rate or bag weight is a typo, and it posts.
    // Only an opening balance may be below zero (an overdrawn bank).
    .refine((v) => options?.allowNegative || !v.startsWith('-') || Number(v) === 0, `${label} cannot be negative.`)
    .optional()
    .transform((v) => (v === undefined || v === '' ? '0' : v));

export const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .length(3, 'Use a three-letter currency code such as USD, AED or MAD.');

/**
 * A day that exists, as midnight UTC.
 *
 * `Date.parse` was the check, and it is lenient: 31 February passed and was
 * saved as 3 March, and "2026-1-5" passed and then failed the save. A year
 * mistyped as 0202 or 20266 is refused too — it would post into a period
 * nobody looks at.
 */
export function calendarDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) return null;
  const day = value.slice(0, 10);
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) return null;
  const year = date.getUTCFullYear();
  return year >= 1990 && year <= 2100 ? date : null;
}

export const dateString = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .refine((v) => calendarDay(v) !== null, `${label} is not a valid date.`)
    .transform((v) => calendarDay(v)!);

export const optionalDateString = z
  .string()
  .trim()
  .optional()
  .refine((v) => !v || calendarDay(v) !== null, 'That is not a valid date.')
  .transform((v) => (!v ? null : calendarDay(v)!));

export const requiredText = (label: string, max = 200) =>
  z.string().trim().min(1, `${label} is required.`).max(max, `${label} is too long.`);

export const optionalText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max, 'That is too long.')
    .optional()
    .transform((v) => (!v ? null : v));

/**
 * A reference to another record: a customer, a coffee, a batch.
 *
 * The message matters. Left off, Zod supplies its own — "Too small: expected
 * string to have >=1 characters" — and that reached the user on a blank
 * Coffee field, which is both meaningless and alarming.
 */
export const cuid = z.string().trim().min(1, 'Choose one from the list.');

/** The same, when the field's own name makes a better message. */
export const requiredChoice = (label: string) =>
  z.string().trim().min(1, `${label} is required.`);

export const optionalCuid = z
  .string()
  .trim()
  .optional()
  .transform((v) => (!v ? null : v));

export const positiveInt = (label: string) =>
  z.coerce.number().int(`${label} must be a whole number.`).min(0, `${label} cannot be negative.`);

/** Turns a FormData object into a plain record Zod can parse. */
export function formDataToObject(formData: FormData): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (key.endsWith('[]')) {
      const arrayKey = key.slice(0, -2);
      const existing = (result[arrayKey] as unknown[]) ?? [];
      existing.push(value);
      result[arrayKey] = existing;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Collapses a ZodError into a field -> message map the forms can render. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_form';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
