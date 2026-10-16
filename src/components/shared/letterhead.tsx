import { companyFlag } from '@/lib/format';

export type LetterheadCompany = {
  name: string;
  legalName: string | null;
  tradingName?: string | null;
  tagline?: string | null;
  address: string | null;
  country: string;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  companyRegistration?: string | null;
  taxLabel?: string | null;
  taxRegistrationNumber?: string | null;
  taxEnabled?: boolean;
  /** Present when the company has uploaded a logo; changes when the logo does. */
  logoUpdatedAt?: Date | null;
};

/** The initials of a name, for a company that has not uploaded a logo. */
export function companyInitials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '·';
  return (words.length === 1 ? words[0].slice(0, 2) : words.slice(0, 2).map((w) => w[0]).join('')).toUpperCase();
}

/**
 * The company's identity at the head of one of its own documents: its logo (or
 * its initials), its legal name and the contact and registration details it
 * has filled in. Always the *signed-in company's* — the logo route accepts no
 * company id — and nothing here knows the product's name.
 */
export function Letterhead({ company, size = 'md' }: { company: LetterheadCompany; size?: 'md' | 'lg' }) {
  const legal = company.legalName || company.name;
  const registrations = [
    company.companyRegistration ? `Reg. ${company.companyRegistration}` : null,
    company.taxEnabled && company.taxRegistrationNumber ? `${company.taxLabel ?? 'Tax'} registration ${company.taxRegistrationNumber}` : null,
  ].filter(Boolean);
  const contact = [company.phone, company.email, company.website].filter(Boolean);
  return (
    <div className="flex items-start gap-3">
      {company.logoUpdatedAt ? (
        // eslint-disable-next-line @next/next/no-img-element -- authenticated route; must print with the page
        <img
          src={`/api/company-logo?v=${company.logoUpdatedAt.getTime()}`}
          alt=""
          className={size === 'lg' ? 'max-h-20 max-w-48 object-contain' : 'max-h-14 max-w-36 shrink-0 object-contain'}
        />
      ) : (
        <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-forest-800 text-sm font-bold text-white" aria-hidden>
          {companyInitials(company.tradingName || company.name)}
        </span>
      )}
      <div>
        <p className="text-lg font-semibold tracking-tight text-ink">{legal}</p>
        {company.tradingName && company.tradingName !== legal ? <p className="text-xs text-ink-muted">Trading as {company.tradingName}</p> : null}
        {registrations.length ? <p className="text-[11px] font-medium text-ink-muted">{registrations.join(' · ')}</p> : null}
        <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
          {companyFlag(company.country)} {company.address}
          {company.address ? <br /> : null}
          {company.country}
          {contact.length ? (
            <>
              <br />
              {contact.join(' · ')}
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}
