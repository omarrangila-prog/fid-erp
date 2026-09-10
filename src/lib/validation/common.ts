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
export const optionalDecimalString = (label: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === '' || /^-?\d+(\.\d+)?$/.test(v), `${label} must be a number.`)
    .optional()
    .transform((v) => (v === undefined || v === '' ? '0' : v));

export const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .length(3, 'Use a three-letter currency code such as USD, AED or MAD.');

export const dateString = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .refine((v) => !Number.isNaN(Date.parse(v)), `${label} is not a valid date.`)
    .transform((v) => new Date(`${v.slice(0, 10)}T00:00:00.000Z`));

export const optionalDateString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (!v ? null : new Date(`${v.slice(0, 10)}T00:00:00.000Z`)))
  .refine((v) => v === null || !Number.isNaN(v.getTime()), 'That is not a valid date.');

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
