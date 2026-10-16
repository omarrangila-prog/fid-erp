/**
 * The few lines under a company's name on anything it shares or prints:
 * legal name, address, how to reach it, and its registration numbers.
 */
export function letterheadLines(c: {
  name: string;
  legalName?: string | null;
  address?: string | null;
  country?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  companyRegistration?: string | null;
  taxEnabled?: boolean | null;
  taxLabel?: string | null;
  taxRegistrationNumber?: string | null;
}): string[] {
  return [
    c.legalName && c.legalName !== c.name ? c.legalName : null,
    [c.address, c.country].filter(Boolean).join(', '),
    [c.phone, c.email, c.website].filter(Boolean).join(' · '),
    [
      c.companyRegistration ? `Reg. ${c.companyRegistration}` : null,
      c.taxEnabled && c.taxRegistrationNumber ? `${c.taxLabel ?? 'Tax'} ${c.taxRegistrationNumber}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  ].filter((line): line is string => Boolean(line));
}
