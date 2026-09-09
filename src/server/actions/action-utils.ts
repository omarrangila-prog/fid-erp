import 'server-only';
import { revalidatePath } from 'next/cache';
import { toErrorResponse } from '@/lib/errors';

/**
 * The shape every Server Action returns. Errors are converted to a user-safe
 * message here; the technical detail is logged server-side by `toErrorResponse`.
 */
export type ActionResult<T = undefined> =
  | { ok: true; data: T; message?: string }
  | { ok: false; error: string; code: string; details?: unknown };

export function ok<T>(data: T, message?: string): ActionResult<T> {
  return { ok: true, data, message };
}

export function fail(error: unknown): ActionResult<never> {
  const response = toErrorResponse(error);
  return { ok: false, error: response.message, code: response.code, details: response.details };
}

/** Wraps an action body so no unhandled exception ever reaches the client. */
export async function run<T>(fn: () => Promise<T>, revalidate?: string[]): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    for (const path of revalidate ?? []) revalidatePath(path);
    return ok(data);
  } catch (error) {
    return fail(error);
  }
}
