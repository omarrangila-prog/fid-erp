import { isCurrencyCode } from '@/lib/currencies';
import { BASE_UOMS, PACK_UOMS } from '@/lib/uom';
import { toCsv, type Table } from '@/lib/import/parse';

/**
 * What a customer can bring in from a spreadsheet, and how each column is read.
 *
 * Every kind has a downloadable template (headers plus one example row) so a
 * new customer starts from a file that already imports cleanly. Columns are
 * matched by name, case-insensitively, with a few aliases — people rename
 * headers — and an unknown column is ignored rather than fatal.
 */

export const IMPORT_KINDS = ['ITEMS', 'CUSTOMERS', 'SUPPLIERS', 'OPENING_STOCK', 'CHART_OF_ACCOUNTS', 'OPENING_BALANCES'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export type ColumnDef = {
  key: string;
  label: string;
  required?: boolean;
  aliases?: string[];
  example: string;
  /** Returns the cleaned value or throws an Error whose message is shown beside the row. */
  parse?: (raw: string) => string | number | null;
};

const text = (max = 200) => (raw: string) => {
  if (raw.length > max) throw new Error(`is longer than ${max} characters`);
  return raw === '' ? null : raw;
};

const upper = (raw: string) => (raw === '' ? null : raw.toUpperCase());

export const money = (raw: string): string | null => {
  if (raw === '') return null;
  const cleaned = raw.replace(/[, ]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) throw new Error(`"${raw}" is not a number`);
  return cleaned;
};

const positive = (raw: string): string | null => {
  const value = money(raw);
  if (value !== null && Number(value) <= 0) throw new Error('must be greater than zero');
  return value;
};

const nonNegative = (raw: string): string | null => {
  const value = money(raw);
  if (value !== null && Number(value) < 0) throw new Error('cannot be negative');
  return value;
};

const days = (raw: string): number | null => {
  if (raw === '') return null;
  if (!/^\d{1,3}$/.test(raw)) throw new Error(`"${raw}" is not a number of days`);
  return Number(raw);
};

const currency = (raw: string): string | null => {
  if (raw === '') return null;
  const code = raw.toUpperCase();
  if (!isCurrencyCode(code)) throw new Error(`"${raw}" is not a currency code the system knows`);
  return code;
};

/** ISO (2026-03-31) or day-first (31/03/2026, 31-03-2026). Anything ambiguous is refused, never guessed. */
export function parseDay(raw: string): string | null {
  if (raw === '') return null;
  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  let y: number;
  let mo: number;
  let d: number;
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else {
    m = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (!m) throw new Error(`"${raw}" is not a date — use YYYY-MM-DD`);
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mo > 12) throw new Error(`"${raw}" is ambiguous — use YYYY-MM-DD`);
  }
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    throw new Error(`"${raw}" is not a real date`);
  }
  return date.toISOString().slice(0, 10);
}

const oneOf = (allowed: readonly string[], what: string) => (raw: string) => {
  if (raw === '') return null;
  const value = raw.toUpperCase();
  if (!allowed.includes(value)) throw new Error(`"${raw}" is not a ${what} (use ${allowed.join(', ')})`);
  return value;
};

export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'] as const;

export const IMPORT_SPECS: Record<ImportKind, { label: string; description: string; columns: ColumnDef[] }> = {
  ITEMS: {
    label: 'Items',
    description: 'Products you buy and sell. Existing items with the same name are skipped.',
    columns: [
      { key: 'itemName', label: 'Item name', required: true, aliases: ['name', 'product', 'product name', 'description'], example: 'Cotton polo shirt, navy', parse: text(200) },
      { key: 'sku', label: 'SKU', aliases: ['code', 'item code', 'sku code'], example: 'POLO-NVY', parse: text(40) },
      { key: 'category', label: 'Category', example: 'Apparel', parse: text(120) },
      { key: 'brand', label: 'Brand', example: 'Northwind', parse: text(120) },
      { key: 'baseUom', label: 'Counted in', aliases: ['unit', 'uom', 'base unit'], example: 'PCS', parse: oneOf(BASE_UOMS, 'unit') },
      { key: 'packUom', label: 'Pack name', aliases: ['pack', 'pack unit'], example: 'CTN', parse: oneOf(PACK_UOMS, 'pack') },
      { key: 'packSize', label: 'Units per pack', aliases: ['pack size', 'per pack'], example: '24', parse: positive },
      { key: 'hsCode', label: 'HS code', aliases: ['hs', 'hscode'], example: '6105.10', parse: text(16) },
      { key: 'taxCategory', label: 'Tax category', example: 'Standard', parse: text(60) },
      { key: 'originCountry', label: 'Country of origin', aliases: ['origin'], example: 'Bangladesh', parse: text(100) },
      { key: 'description', label: 'Description', example: '180 GSM cotton', parse: text(600) },
    ],
  },
  CUSTOMERS: {
    label: 'Customers',
    description: 'People and companies you sell to. An opening balance is what they owe you at the start date.',
    columns: [
      { key: 'name', label: 'Customer name', required: true, aliases: ['customer', 'buyer', 'name'], example: 'Al Noor Trading LLC', parse: text(200) },
      { key: 'code', label: 'Code', example: 'C-001', parse: text(40) },
      { key: 'country', label: 'Country', example: 'United Arab Emirates', parse: text(100) },
      { key: 'contactPerson', label: 'Contact person', aliases: ['contact'], example: 'Sara Ahmed', parse: text(120) },
      { key: 'phone', label: 'Phone', example: '+971 4 555 0100', parse: text(40) },
      { key: 'email', label: 'Email', example: 'accounts@alnoor.example', parse: text(200) },
      { key: 'address', label: 'Address', example: 'Deira, Dubai', parse: text(400) },
      { key: 'currency', label: 'Currency', required: true, aliases: ['ledger currency', 'account currency'], example: 'AED', parse: currency },
      { key: 'paymentTermDays', label: 'Payment terms (days)', aliases: ['terms', 'payment terms'], example: '30', parse: days },
      { key: 'creditLimit', label: 'Credit limit', example: '50000', parse: nonNegative },
      { key: 'openingBalance', label: 'Opening balance', aliases: ['opening', 'balance', 'owes'], example: '12500.00', parse: nonNegative },
      { key: 'openingDate', label: 'Opening balance date', aliases: ['as of', 'balance date'], example: '2026-01-01', parse: parseDay },
    ],
  },
  SUPPLIERS: {
    label: 'Suppliers',
    description: 'People and companies you buy from. An opening balance is what you owe them at the start date.',
    columns: [
      { key: 'name', label: 'Supplier name', required: true, aliases: ['supplier', 'vendor', 'name'], example: 'Shenzhen Textiles Co', parse: text(200) },
      { key: 'code', label: 'Code', example: 'S-001', parse: text(40) },
      { key: 'country', label: 'Country', example: 'China', parse: text(100) },
      { key: 'contactPerson', label: 'Contact person', aliases: ['contact'], example: 'Li Wei', parse: text(120) },
      { key: 'phone', label: 'Phone', example: '+86 755 5550 100', parse: text(40) },
      { key: 'email', label: 'Email', example: 'sales@sztex.example', parse: text(200) },
      { key: 'address', label: 'Address', example: 'Shenzhen', parse: text(400) },
      { key: 'currency', label: 'Currency', required: true, aliases: ['ledger currency', 'account currency'], example: 'USD', parse: currency },
      { key: 'openingBalance', label: 'Opening balance', aliases: ['opening', 'balance', 'we owe'], example: '8200.00', parse: nonNegative },
      { key: 'openingDate', label: 'Opening balance date', aliases: ['as of', 'balance date'], example: '2026-01-01', parse: parseDay },
    ],
  },
  OPENING_STOCK: {
    label: 'Opening stock',
    description: 'Stock already in your warehouses on the start date, with its cost. Items and warehouses must exist.',
    columns: [
      { key: 'itemName', label: 'Item name', required: true, aliases: ['item', 'product', 'sku'], example: 'Cotton polo shirt, navy', parse: text(200) },
      { key: 'warehouse', label: 'Warehouse', required: true, aliases: ['store', 'location'], example: 'Main warehouse', parse: text(160) },
      { key: 'quantity', label: 'Quantity', required: true, aliases: ['qty', 'on hand'], example: '1200', parse: positive },
      { key: 'unitCost', label: 'Unit cost', required: true, aliases: ['cost', 'cost per unit', 'rate'], example: '4.20', parse: nonNegative },
      { key: 'currency', label: 'Currency', required: true, example: 'USD', parse: currency },
      { key: 'lot', label: 'Lot / batch', aliases: ['lot number', 'batch'], example: 'LOT-2025-11', parse: text(60) },
      { key: 'asOf', label: 'As of date', required: true, aliases: ['date', 'opening date'], example: '2026-01-01', parse: parseDay },
    ],
  },
  CHART_OF_ACCOUNTS: {
    label: 'Chart of accounts',
    description: 'Extra ledger accounts, added to the standard chart. Existing names are skipped.',
    columns: [
      { key: 'code', label: 'Account code', aliases: ['code', 'number'], example: '6150', parse: text(20) },
      { key: 'name', label: 'Account name', required: true, aliases: ['account', 'name'], example: 'Staff welfare', parse: text(160) },
      { key: 'type', label: 'Type', required: true, aliases: ['account type'], example: 'EXPENSE', parse: oneOf(ACCOUNT_TYPES, 'account type') },
      { key: 'currency', label: 'Currency', example: '', parse: currency },
    ],
  },
  OPENING_BALANCES: {
    label: 'Opening balances',
    description: 'Opening balance on a ledger account (bank, loan, equity…). Each line is posted against Opening Balances equity.',
    columns: [
      { key: 'account', label: 'Account name', required: true, aliases: ['account', 'ledger account'], example: 'Emirates NBD current account', parse: text(160) },
      { key: 'amount', label: 'Amount', required: true, aliases: ['balance', 'opening balance'], example: '25000.00', parse: nonNegative },
      { key: 'side', label: 'Debit or credit', aliases: ['dr/cr', 'side', 'direction'], example: 'DEBIT', parse: oneOf(['DEBIT', 'CREDIT', 'DR', 'CR'], 'side') },
      { key: 'currency', label: 'Currency', example: 'AED', parse: currency },
      { key: 'asOf', label: 'As of date', required: true, aliases: ['date', 'opening date'], example: '2026-01-01', parse: parseDay },
    ],
  },
};

export type ParsedRow = {
  /** 1-based spreadsheet row number (header is row 1). */
  line: number;
  values: Record<string, string | number | null>;
  errors: string[];
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Which table column feeds which field, by header name. */
export function mapColumns(kind: ImportKind, headers: string[]): { index: Record<string, number>; missing: string[]; unknown: string[] } {
  const spec = IMPORT_SPECS[kind];
  const normalised = headers.map(norm);
  const index: Record<string, number> = {};
  for (const col of spec.columns) {
    const names = [col.label, col.key, ...(col.aliases ?? [])].map(norm);
    const at = normalised.findIndex((h) => names.includes(h));
    if (at >= 0) index[col.key] = at;
  }
  const used = new Set(Object.values(index));
  return {
    index,
    missing: spec.columns.filter((c) => c.required && index[c.key] === undefined).map((c) => c.label),
    unknown: headers.filter((_, i) => !used.has(i) && headers[i] !== ''),
  };
}

export function parseRows(kind: ImportKind, table: Table): { rows: ParsedRow[]; missing: string[]; unknown: string[] } {
  const { index, missing, unknown } = mapColumns(kind, table.headers);
  if (missing.length > 0) return { rows: [], missing, unknown };
  const spec = IMPORT_SPECS[kind];
  const rows = table.rows.map((cells, i): ParsedRow => {
    const values: ParsedRow['values'] = {};
    const errors: string[] = [];
    for (const col of spec.columns) {
      const at = index[col.key];
      const raw = at === undefined ? '' : (cells[at] ?? '');
      try {
        const parsed = col.parse ? col.parse(raw) : raw === '' ? null : raw;
        values[col.key] = parsed;
        if (col.required && (parsed === null || parsed === '')) errors.push(`${col.label} is required`);
      } catch (error) {
        errors.push(`${col.label} ${(error as Error).message}`);
      }
    }
    return { line: i + 2, values, errors };
  });
  return { rows, missing, unknown };
}

/** The downloadable template: headers plus one example row. */
export function templateCsv(kind: ImportKind): string {
  const spec = IMPORT_SPECS[kind];
  return toCsv(spec.columns.map((c) => c.label), [spec.columns.map((c) => c.example)]);
}
