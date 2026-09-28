/**
 * People who sign in with a PIN only have no email address, but the account
 * record still needs a unique one. They get an internal address on this
 * domain, which is never shown and can never receive mail or sign in.
 */
export const PIN_ONLY_EMAIL_DOMAIN = 'pin-only.fid.invalid';

export function isPinOnlyEmail(email: string | null | undefined): boolean {
  return Boolean(email?.toLowerCase().endsWith(`@${PIN_ONLY_EMAIL_DOMAIN}`));
}
