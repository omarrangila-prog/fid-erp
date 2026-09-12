/**
 * The credentials the browser tests sign in with.
 *
 * They used to read `E2E_EMAIL` and `E2E_PASSWORD` directly and assert them
 * non-null with `!`. Nobody sets those — the seed creates the account named by
 * `INITIAL_ADMIN_EMAIL` — so four spec files failed at the first `fill()` with
 * "value: expected string, got undefined", which names neither the missing
 * variable nor the file it belongs in. Forty tests failed that way and the
 * count was easy to read past.
 *
 * So: prefer the E2E names, fall back to the ones the seed already uses, and
 * when neither is set skip the file the way the PIN specs do — a skip says
 * "not configured", a failure says "broken", and they are different things.
 */

export const E2E_EMAIL = process.env.E2E_EMAIL ?? process.env.INITIAL_ADMIN_EMAIL;
export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? process.env.INITIAL_ADMIN_PASSWORD;

export const PASSWORD_SIGN_IN_CONFIGURED = Boolean(E2E_EMAIL && E2E_PASSWORD);

export const NO_PASSWORD_CREDENTIALS =
  'Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD (or E2E_EMAIL and E2E_PASSWORD) to run these.';
