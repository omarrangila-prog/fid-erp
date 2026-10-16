/**
 * Countries the onboarding wizard offers, each with the defaults a company
 * there usually wants: its currency, time zone, what its consumption tax is
 * called, and how dates and numbers are customarily written.
 *
 * These are *starting suggestions*, all editable afterwards. In particular no
 * tax RATE appears here: rates change, differ by goods, and are the owner's to
 * state — the product never presumes one. Nor does anything here claim that
 * the product satisfies a country's statutory e-invoicing or filing rules.
 */

export type DateFormat = 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'DD MMM YYYY';

export type Country = {
  code: string;
  name: string;
  currency: string;
  timezone: string;
  /** What the sales / consumption tax is called locally. */
  taxLabel: string;
  dateFormat: DateFormat;
  /** BCP-47 locale for grouping digits and the decimal mark. */
  locale: string;
};

const D = 'DD/MM/YYYY';
const M = 'MM/DD/YYYY';
const I = 'YYYY-MM-DD';

// code, name, currency, timezone, tax label, date format, locale
const ROWS: ReadonlyArray<readonly [string, string, string, string, string, DateFormat, string]> = [
  ['AE', 'United Arab Emirates', 'AED', 'Asia/Dubai', 'VAT', D, 'en-AE'],
  ['AF', 'Afghanistan', 'AFN', 'Asia/Kabul', 'Sales tax', D, 'en-US'],
  ['AL', 'Albania', 'ALL', 'Europe/Tirane', 'VAT', D, 'sq-AL'],
  ['AM', 'Armenia', 'AMD', 'Asia/Yerevan', 'VAT', D, 'hy-AM'],
  ['AO', 'Angola', 'AOA', 'Africa/Luanda', 'VAT', D, 'pt-AO'],
  ['AR', 'Argentina', 'ARS', 'America/Argentina/Buenos_Aires', 'VAT', D, 'es-AR'],
  ['AT', 'Austria', 'EUR', 'Europe/Vienna', 'VAT', D, 'de-AT'],
  ['AU', 'Australia', 'AUD', 'Australia/Sydney', 'GST', D, 'en-AU'],
  ['AZ', 'Azerbaijan', 'AZN', 'Asia/Baku', 'VAT', D, 'az-AZ'],
  ['BA', 'Bosnia and Herzegovina', 'BAM', 'Europe/Sarajevo', 'VAT', D, 'bs-BA'],
  ['BD', 'Bangladesh', 'BDT', 'Asia/Dhaka', 'VAT', D, 'bn-BD'],
  ['BE', 'Belgium', 'EUR', 'Europe/Brussels', 'VAT', D, 'nl-BE'],
  ['BG', 'Bulgaria', 'BGN', 'Europe/Sofia', 'VAT', D, 'bg-BG'],
  ['BH', 'Bahrain', 'BHD', 'Asia/Bahrain', 'VAT', D, 'ar-BH'],
  ['BO', 'Bolivia', 'BOB', 'America/La_Paz', 'VAT', D, 'es-BO'],
  ['BR', 'Brazil', 'BRL', 'America/Sao_Paulo', 'Sales tax', D, 'pt-BR'],
  ['BW', 'Botswana', 'BWP', 'Africa/Gaborone', 'VAT', D, 'en-BW'],
  ['BY', 'Belarus', 'BYN', 'Europe/Minsk', 'VAT', D, 'be-BY'],
  ['CA', 'Canada', 'CAD', 'America/Toronto', 'GST', I, 'en-CA'],
  ['CD', 'DR Congo', 'CDF', 'Africa/Kinshasa', 'VAT', D, 'fr-CD'],
  ['CH', 'Switzerland', 'CHF', 'Europe/Zurich', 'VAT', D, 'de-CH'],
  ['CI', 'Côte d’Ivoire', 'XOF', 'Africa/Abidjan', 'TVA', D, 'fr-CI'],
  ['CL', 'Chile', 'CLP', 'America/Santiago', 'VAT', D, 'es-CL'],
  ['CM', 'Cameroon', 'XAF', 'Africa/Douala', 'TVA', D, 'fr-CM'],
  ['CN', 'China', 'CNY', 'Asia/Shanghai', 'VAT', I, 'zh-CN'],
  ['CO', 'Colombia', 'COP', 'America/Bogota', 'VAT', D, 'es-CO'],
  ['CR', 'Costa Rica', 'CRC', 'America/Costa_Rica', 'VAT', D, 'es-CR'],
  ['CY', 'Cyprus', 'EUR', 'Asia/Nicosia', 'VAT', D, 'el-CY'],
  ['CZ', 'Czechia', 'CZK', 'Europe/Prague', 'VAT', D, 'cs-CZ'],
  ['DE', 'Germany', 'EUR', 'Europe/Berlin', 'VAT', D, 'de-DE'],
  ['DK', 'Denmark', 'DKK', 'Europe/Copenhagen', 'VAT', D, 'da-DK'],
  ['DO', 'Dominican Republic', 'DOP', 'America/Santo_Domingo', 'Sales tax', D, 'es-DO'],
  ['DZ', 'Algeria', 'DZD', 'Africa/Algiers', 'TVA', D, 'fr-DZ'],
  ['EC', 'Ecuador', 'USD', 'America/Guayaquil', 'VAT', D, 'es-EC'],
  ['EE', 'Estonia', 'EUR', 'Europe/Tallinn', 'VAT', D, 'et-EE'],
  ['EG', 'Egypt', 'EGP', 'Africa/Cairo', 'VAT', D, 'ar-EG'],
  ['ES', 'Spain', 'EUR', 'Europe/Madrid', 'VAT', D, 'es-ES'],
  ['ET', 'Ethiopia', 'ETB', 'Africa/Addis_Ababa', 'VAT', D, 'am-ET'],
  ['FI', 'Finland', 'EUR', 'Europe/Helsinki', 'VAT', D, 'fi-FI'],
  ['FJ', 'Fiji', 'FJD', 'Pacific/Fiji', 'VAT', D, 'en-FJ'],
  ['FR', 'France', 'EUR', 'Europe/Paris', 'TVA', D, 'fr-FR'],
  ['GB', 'United Kingdom', 'GBP', 'Europe/London', 'VAT', D, 'en-GB'],
  ['GE', 'Georgia', 'GEL', 'Asia/Tbilisi', 'VAT', D, 'ka-GE'],
  ['GH', 'Ghana', 'GHS', 'Africa/Accra', 'VAT', D, 'en-GH'],
  ['GR', 'Greece', 'EUR', 'Europe/Athens', 'VAT', D, 'el-GR'],
  ['GT', 'Guatemala', 'GTQ', 'America/Guatemala', 'VAT', D, 'es-GT'],
  ['HK', 'Hong Kong', 'HKD', 'Asia/Hong_Kong', 'Sales tax', D, 'en-HK'],
  ['HN', 'Honduras', 'HNL', 'America/Tegucigalpa', 'Sales tax', D, 'es-HN'],
  ['HR', 'Croatia', 'EUR', 'Europe/Zagreb', 'VAT', D, 'hr-HR'],
  ['HU', 'Hungary', 'HUF', 'Europe/Budapest', 'VAT', I, 'hu-HU'],
  ['ID', 'Indonesia', 'IDR', 'Asia/Jakarta', 'VAT', D, 'id-ID'],
  ['IE', 'Ireland', 'EUR', 'Europe/Dublin', 'VAT', D, 'en-IE'],
  ['IL', 'Israel', 'ILS', 'Asia/Jerusalem', 'VAT', D, 'he-IL'],
  ['IN', 'India', 'INR', 'Asia/Kolkata', 'GST', D, 'en-IN'],
  ['IQ', 'Iraq', 'IQD', 'Asia/Baghdad', 'Sales tax', D, 'ar-IQ'],
  ['IS', 'Iceland', 'ISK', 'Atlantic/Reykjavik', 'VAT', D, 'is-IS'],
  ['IT', 'Italy', 'EUR', 'Europe/Rome', 'VAT', D, 'it-IT'],
  ['JM', 'Jamaica', 'JMD', 'America/Jamaica', 'GCT', D, 'en-JM'],
  ['JO', 'Jordan', 'JOD', 'Asia/Amman', 'Sales tax', D, 'ar-JO'],
  ['JP', 'Japan', 'JPY', 'Asia/Tokyo', 'Consumption tax', I, 'ja-JP'],
  ['KE', 'Kenya', 'KES', 'Africa/Nairobi', 'VAT', D, 'en-KE'],
  ['KH', 'Cambodia', 'KHR', 'Asia/Phnom_Penh', 'VAT', D, 'km-KH'],
  ['KR', 'South Korea', 'KRW', 'Asia/Seoul', 'VAT', I, 'ko-KR'],
  ['KW', 'Kuwait', 'KWD', 'Asia/Kuwait', 'Sales tax', D, 'ar-KW'],
  ['KZ', 'Kazakhstan', 'KZT', 'Asia/Almaty', 'VAT', D, 'kk-KZ'],
  ['LB', 'Lebanon', 'LBP', 'Asia/Beirut', 'VAT', D, 'ar-LB'],
  ['LK', 'Sri Lanka', 'LKR', 'Asia/Colombo', 'VAT', I, 'si-LK'],
  ['LT', 'Lithuania', 'EUR', 'Europe/Vilnius', 'VAT', I, 'lt-LT'],
  ['LU', 'Luxembourg', 'EUR', 'Europe/Luxembourg', 'TVA', D, 'fr-LU'],
  ['LV', 'Latvia', 'EUR', 'Europe/Riga', 'VAT', D, 'lv-LV'],
  ['LY', 'Libya', 'LYD', 'Africa/Tripoli', 'Sales tax', D, 'ar-LY'],
  ['MA', 'Morocco', 'MAD', 'Africa/Casablanca', 'TVA', D, 'fr-MA'],
  ['MD', 'Moldova', 'MDL', 'Europe/Chisinau', 'VAT', D, 'ro-MD'],
  ['MG', 'Madagascar', 'MGA', 'Indian/Antananarivo', 'TVA', D, 'fr-MG'],
  ['MK', 'North Macedonia', 'MKD', 'Europe/Skopje', 'VAT', D, 'mk-MK'],
  ['MM', 'Myanmar', 'MMK', 'Asia/Yangon', 'Commercial tax', D, 'my-MM'],
  ['MT', 'Malta', 'EUR', 'Europe/Malta', 'VAT', D, 'mt-MT'],
  ['MU', 'Mauritius', 'MUR', 'Indian/Mauritius', 'VAT', D, 'en-MU'],
  ['MX', 'Mexico', 'MXN', 'America/Mexico_City', 'VAT', D, 'es-MX'],
  ['MY', 'Malaysia', 'MYR', 'Asia/Kuala_Lumpur', 'Sales tax', D, 'ms-MY'],
  ['MZ', 'Mozambique', 'MZN', 'Africa/Maputo', 'VAT', D, 'pt-MZ'],
  ['NA', 'Namibia', 'NAD', 'Africa/Windhoek', 'VAT', D, 'en-NA'],
  ['NG', 'Nigeria', 'NGN', 'Africa/Lagos', 'VAT', D, 'en-NG'],
  ['NI', 'Nicaragua', 'NIO', 'America/Managua', 'VAT', D, 'es-NI'],
  ['NL', 'Netherlands', 'EUR', 'Europe/Amsterdam', 'VAT', D, 'nl-NL'],
  ['NO', 'Norway', 'NOK', 'Europe/Oslo', 'VAT', D, 'nb-NO'],
  ['NP', 'Nepal', 'NPR', 'Asia/Kathmandu', 'VAT', I, 'ne-NP'],
  ['NZ', 'New Zealand', 'NZD', 'Pacific/Auckland', 'GST', D, 'en-NZ'],
  ['OM', 'Oman', 'OMR', 'Asia/Muscat', 'VAT', D, 'ar-OM'],
  ['PA', 'Panama', 'PAB', 'America/Panama', 'ITBMS', D, 'es-PA'],
  ['PE', 'Peru', 'PEN', 'America/Lima', 'IGV', D, 'es-PE'],
  ['PG', 'Papua New Guinea', 'PGK', 'Pacific/Port_Moresby', 'GST', D, 'en-PG'],
  ['PH', 'Philippines', 'PHP', 'Asia/Manila', 'VAT', M, 'en-PH'],
  ['PK', 'Pakistan', 'PKR', 'Asia/Karachi', 'Sales tax', D, 'en-PK'],
  ['PL', 'Poland', 'PLN', 'Europe/Warsaw', 'VAT', D, 'pl-PL'],
  ['PT', 'Portugal', 'EUR', 'Europe/Lisbon', 'VAT', D, 'pt-PT'],
  ['PY', 'Paraguay', 'PYG', 'America/Asuncion', 'VAT', D, 'es-PY'],
  ['QA', 'Qatar', 'QAR', 'Asia/Qatar', 'VAT', D, 'ar-QA'],
  ['RO', 'Romania', 'RON', 'Europe/Bucharest', 'VAT', D, 'ro-RO'],
  ['RS', 'Serbia', 'RSD', 'Europe/Belgrade', 'VAT', D, 'sr-RS'],
  ['RU', 'Russia', 'RUB', 'Europe/Moscow', 'VAT', D, 'ru-RU'],
  ['RW', 'Rwanda', 'RWF', 'Africa/Kigali', 'VAT', D, 'en-RW'],
  ['SA', 'Saudi Arabia', 'SAR', 'Asia/Riyadh', 'VAT', D, 'ar-SA'],
  ['SE', 'Sweden', 'SEK', 'Europe/Stockholm', 'VAT', I, 'sv-SE'],
  ['SG', 'Singapore', 'SGD', 'Asia/Singapore', 'GST', D, 'en-SG'],
  ['SI', 'Slovenia', 'EUR', 'Europe/Ljubljana', 'VAT', D, 'sl-SI'],
  ['SK', 'Slovakia', 'EUR', 'Europe/Bratislava', 'VAT', D, 'sk-SK'],
  ['SN', 'Senegal', 'XOF', 'Africa/Dakar', 'TVA', D, 'fr-SN'],
  ['SV', 'El Salvador', 'USD', 'America/El_Salvador', 'VAT', D, 'es-SV'],
  ['TH', 'Thailand', 'THB', 'Asia/Bangkok', 'VAT', D, 'th-TH'],
  ['TN', 'Tunisia', 'TND', 'Africa/Tunis', 'TVA', D, 'fr-TN'],
  ['TR', 'Türkiye', 'TRY', 'Europe/Istanbul', 'VAT', D, 'tr-TR'],
  ['TW', 'Taiwan', 'TWD', 'Asia/Taipei', 'VAT', I, 'zh-TW'],
  ['TZ', 'Tanzania', 'TZS', 'Africa/Dar_es_Salaam', 'VAT', D, 'sw-TZ'],
  ['UA', 'Ukraine', 'UAH', 'Europe/Kyiv', 'VAT', D, 'uk-UA'],
  ['UG', 'Uganda', 'UGX', 'Africa/Kampala', 'VAT', D, 'en-UG'],
  ['US', 'United States', 'USD', 'America/New_York', 'Sales tax', M, 'en-US'],
  ['UY', 'Uruguay', 'UYU', 'America/Montevideo', 'VAT', D, 'es-UY'],
  ['UZ', 'Uzbekistan', 'UZS', 'Asia/Tashkent', 'VAT', D, 'uz-UZ'],
  ['VE', 'Venezuela', 'VES', 'America/Caracas', 'VAT', D, 'es-VE'],
  ['VN', 'Vietnam', 'VND', 'Asia/Ho_Chi_Minh', 'VAT', D, 'vi-VN'],
  ['ZA', 'South Africa', 'ZAR', 'Africa/Johannesburg', 'VAT', I, 'en-ZA'],
  ['ZM', 'Zambia', 'ZMW', 'Africa/Lusaka', 'VAT', D, 'en-ZM'],
  ['ZW', 'Zimbabwe', 'ZWG', 'Africa/Harare', 'VAT', D, 'en-ZW'],
];

export const COUNTRIES: ReadonlyArray<Country> = ROWS.map(
  ([code, name, currency, timezone, taxLabel, dateFormat, locale]) => ({ code, name, currency, timezone, taxLabel, dateFormat, locale }),
);

const BY_NAME = new Map(COUNTRIES.map((c) => [c.name.toLowerCase(), c]));
const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

export function countryByCode(code: string | null | undefined): Country | undefined {
  return code ? BY_CODE.get(code.toUpperCase()) : undefined;
}

/** Companies store the country by name; this finds its defaults. */
export function countryByName(name: string | null | undefined): Country | undefined {
  return name ? BY_NAME.get(name.trim().toLowerCase()) : undefined;
}

/** Two-letter code for a stored country name, for flags and port lists. */
export function countryCodeOf(name: string | null | undefined): string | null {
  return countryByName(name)?.code ?? null;
}
