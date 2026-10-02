/**
 * A server action called from a dialog, made unable to throw.
 *
 * An action answers `{ ok: false, error }` for everything it decides itself.
 * It throws only when the request fails on the way — the connection drops, or
 * a new release has replaced the action this page was built against. A dialog
 * that set "busy" before the call never cleared it, and sat spinning with its
 * buttons locked. Wrapped, that failure is just another error to show.
 */
export async function safely<T>(call: Promise<T>): Promise<T | { ok: false; error: string; code: string }> {
  try {
    return await call;
  } catch {
    return {
      ok: false,
      error: 'The request did not reach the server. Check the connection, reload the page and try again.',
      code: 'NETWORK_ERROR',
    };
  }
}
