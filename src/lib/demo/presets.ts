/**
 * Four fictional businesses for demonstrations, screenshots and sales videos.
 *
 * Everything here is invented — company names, people, addresses, phone
 * numbers, registration numbers, prices and exchange rates. Nothing is taken
 * from any real customer, and no real brand is used. Exchange rates are round
 * illustrative figures, not market data.
 */

export type DemoItem = {
  name: string;
  sku: string;
  category: string;
  brand?: string;
  baseUom: 'KG' | 'PCS' | 'M' | 'L';
  packUom: 'BAG' | 'CTN' | 'BOX' | 'ROLL' | 'PLT' | 'PACK';
  packSize: number;
  hsCode: string;
  origin: string;
  /** Supplier price per base unit, in USD. */
  costUsd: number;
  /** Industry attributes (size, colour, …) or the coffee facts. */
  attributes?: Record<string, string>;
  coffee?: { coffeeType: 'ARABICA' | 'ROBUSTA'; grade: string; screenSize?: string; region?: string; cropYear: string; process: 'WASHED' | 'NATURAL' };
};

export type DemoParty = { name: string; country: string; currency: string; terms?: number; contact: string; email: string };

export type DemoPurchase = {
  vendor: number;
  daysAgo: number;
  lines: Array<{ item: number; qty: number }>;
  freightUsd: number;
  /** Null: still on the water. */
  receivedDaysAgo: number | null;
  warehouse: number;
  clearingLocal?: number;
  paidShare?: number;
};

export type DemoSale = {
  customer: number;
  daysAgo: number;
  currency: string;
  lines: Array<{ item: number; qty: number; markup: number }>;
  settle: 'full' | 'part' | 'none';
};

export type DemoSpec = {
  key: 'general' | 'coffee' | 'apparel' | 'distribution';
  label: string;
  company: { name: string; legalName: string; country: string; template: string; tagline: string; address: string; phone: string; email: string; website: string; registration: string };
  /** Units of local currency per 1 USD (illustrative). */
  rates: Record<string, string>;
  transactionCurrencies: string[];
  salesCurrencies: string[];
  defaultSalesCurrency?: string;
  tax?: { registration: string; label: string; ratePct: string };
  warehouses: Array<{ name: string; location: string; port?: string }>;
  vendors: DemoParty[];
  customers: DemoParty[];
  items: DemoItem[];
  purchases: DemoPurchase[];
  sales: DemoSale[];
  expensesLocal: Array<{ amount: number; daysAgo: number; description: string }>;
  logistics: boolean;
};

export const DEMO_ORGANIZATION = 'Global Trading Demo LLC';

export const DEMO_PRESETS: DemoSpec[] = [
  {
    key: 'general',
    label: 'General trading',
    company: {
      name: 'Global Trading Demo LLC',
      legalName: 'GLOBAL TRADING DEMO L.L.C.',
      country: 'United Arab Emirates',
      template: 'GENERAL_TRADING',
      tagline: 'Sourcing the world, delivered locally',
      address: 'Office 1204, Demo Business Tower, Business Bay, Dubai',
      phone: '+971 4 000 0100',
      email: 'accounts@globaltrading.example',
      website: 'www.globaltrading.example',
      registration: 'DEMO-LIC-000123',
    },
    rates: { AED: '3.6725', EUR: '0.9200' },
    transactionCurrencies: ['USD', 'AED', 'EUR'],
    salesCurrencies: ['AED', 'USD'],
    defaultSalesCurrency: 'AED',
    tax: { registration: 'DEMO-TRN-100000000000003', label: 'VAT', ratePct: '5' },
    warehouses: [
      { name: 'Jebel Ali Warehouse', location: 'Jebel Ali Free Zone', port: 'Jebel Ali' },
      { name: 'Al Quoz Store', location: 'Al Quoz, Dubai' },
    ],
    vendors: [
      { name: 'Shenzhen BrightLite Co. Ltd', country: 'China', currency: 'USD', terms: 30, contact: 'Li Wei', email: 'sales@brightlite.example' },
      { name: 'Guangzhou HomeWare Trading', country: 'China', currency: 'USD', terms: 45, contact: 'Chen Mei', email: 'export@homeware.example' },
    ],
    customers: [
      { name: 'Al Noor Electrical LLC', country: 'United Arab Emirates', currency: 'AED', terms: 30, contact: 'Sara Ahmed', email: 'buying@alnoor.example' },
      { name: 'Desert Rose Retail', country: 'United Arab Emirates', currency: 'AED', terms: 15, contact: 'Omar Khalid', email: 'orders@desertrose.example' },
      { name: 'Gulf Hospitality Supplies', country: 'Qatar', currency: 'USD', terms: 30, contact: 'Nadia Farouk', email: 'procure@gulfhs.example' },
    ],
    items: [
      { name: 'LED panel light 60x60 40W', sku: 'LED-6060-40', category: 'Lighting', brand: 'BrightLite', baseUom: 'PCS', packUom: 'CTN', packSize: 4, hsCode: '9405.42', origin: 'China', costUsd: 11.5 },
      { name: 'Insulated steel bottle 750ml', sku: 'BTL-750-SS', category: 'Homeware', brand: 'HomeKeep', baseUom: 'PCS', packUom: 'CTN', packSize: 24, hsCode: '9617.00', origin: 'China', costUsd: 3.2 },
      { name: 'Ergonomic office chair', sku: 'CHR-ERG-01', category: 'Furniture', brand: 'Seatwell', baseUom: 'PCS', packUom: 'PLT', packSize: 20, hsCode: '9401.30', origin: 'China', costUsd: 48 },
    ],
    purchases: [
      { vendor: 0, daysAgo: 120, lines: [{ item: 0, qty: 4000 }], freightUsd: 3800, receivedDaysAgo: 80, warehouse: 0, clearingLocal: 7400, paidShare: 1 },
      { vendor: 1, daysAgo: 70, lines: [{ item: 1, qty: 12000 }, { item: 2, qty: 600 }], freightUsd: 5200, receivedDaysAgo: 34, warehouse: 0, clearingLocal: 9600, paidShare: 0.5 },
      { vendor: 0, daysAgo: 20, lines: [{ item: 0, qty: 3000 }], freightUsd: 2900, receivedDaysAgo: null, warehouse: 1 },
    ],
    sales: [
      { customer: 0, daysAgo: 70, currency: 'AED', lines: [{ item: 0, qty: 900, markup: 1.42 }], settle: 'full' },
      { customer: 1, daysAgo: 55, currency: 'AED', lines: [{ item: 0, qty: 700, markup: 1.45 }], settle: 'part' },
      { customer: 2, daysAgo: 28, currency: 'USD', lines: [{ item: 1, qty: 3000, markup: 1.4 }, { item: 2, qty: 120, markup: 1.38 }], settle: 'part' },
      { customer: 0, daysAgo: 14, currency: 'AED', lines: [{ item: 1, qty: 1800, markup: 1.44 }], settle: 'none' },
      { customer: 1, daysAgo: 6, currency: 'AED', lines: [{ item: 2, qty: 90, markup: 1.4 }], settle: 'none' },
    ],
    expensesLocal: [
      { amount: 5200, daysAgo: 60, description: 'Warehouse rent — quarter' },
      { amount: 1450, daysAgo: 40, description: 'Bank charges and remittance fees' },
      { amount: 980, daysAgo: 10, description: 'Courier and documentation' },
    ],
    logistics: true,
  },
  {
    key: 'coffee',
    label: 'Coffee / commodity',
    company: {
      name: 'Aroma Origin Trading SARL',
      legalName: 'AROMA ORIGIN TRADING SARL',
      country: 'Morocco',
      template: 'COMMODITY_TRADING',
      tagline: 'Green coffee, traced to the lot',
      address: '12 Rue du Port Demo, Casablanca',
      phone: '+212 5 22 00 00 00',
      email: 'contact@aromaorigin.example',
      website: 'www.aromaorigin.example',
      registration: 'DEMO-RC-000456',
    },
    rates: { MAD: '9.9000' },
    transactionCurrencies: ['MAD', 'USD'],
    salesCurrencies: ['MAD'],
    defaultSalesCurrency: 'MAD',
    warehouses: [
      { name: 'Casablanca Warehouse A', location: 'Casablanca', port: 'Casablanca' },
      { name: 'Casablanca Warehouse B', location: 'Casablanca' },
    ],
    vendors: [
      { name: 'Fazenda Demo Exportadora', country: 'Brazil', currency: 'USD', terms: 30, contact: 'Paulo Demo', email: 'export@fazendademo.example' },
      { name: 'Highland Coffee Exporters Ltd', country: 'Uganda', currency: 'USD', terms: 30, contact: 'Grace Demo', email: 'sales@highlandcoffee.example' },
    ],
    customers: [
      { name: 'Torréfaction Atlas', country: 'Morocco', currency: 'MAD', terms: 30, contact: 'Youssef B.', email: 'achats@atlasroast.example' },
      { name: 'Café Médina Distribution', country: 'Morocco', currency: 'MAD', terms: 21, contact: 'Salma R.', email: 'compta@medinacafe.example' },
    ],
    items: [
      { name: 'Brazil Santos NY2 Screen 17/18', sku: 'BR-SANTOS-NY2', category: 'Green coffee', baseUom: 'KG', packUom: 'BAG', packSize: 60, hsCode: '0901.11', origin: 'Brazil', costUsd: 4.1, coffee: { coffeeType: 'ARABICA', grade: 'NY2', screenSize: '17/18', region: 'Mogiana', cropYear: '2025/26', process: 'NATURAL' } },
      { name: 'Uganda Robusta Screen 15', sku: 'UG-ROB-S15', category: 'Green coffee', baseUom: 'KG', packUom: 'BAG', packSize: 60, hsCode: '0901.11', origin: 'Uganda', costUsd: 2.9, coffee: { coffeeType: 'ROBUSTA', grade: 'Screen 15', region: 'Masaka', cropYear: '2025/26', process: 'NATURAL' } },
    ],
    purchases: [
      { vendor: 0, daysAgo: 130, lines: [{ item: 0, qty: 19200 }], freightUsd: 4100, receivedDaysAgo: 82, warehouse: 0, clearingLocal: 38000, paidShare: 1 },
      { vendor: 1, daysAgo: 75, lines: [{ item: 1, qty: 19200 }], freightUsd: 3600, receivedDaysAgo: 36, warehouse: 1, clearingLocal: 33000, paidShare: 0.6 },
      { vendor: 0, daysAgo: 18, lines: [{ item: 0, qty: 19200 }], freightUsd: 4300, receivedDaysAgo: null, warehouse: 0 },
    ],
    sales: [
      { customer: 0, daysAgo: 70, currency: 'MAD', lines: [{ item: 0, qty: 6000, markup: 1.33 }], settle: 'full' },
      { customer: 1, daysAgo: 48, currency: 'MAD', lines: [{ item: 1, qty: 5400, markup: 1.36 }], settle: 'part' },
      { customer: 0, daysAgo: 22, currency: 'MAD', lines: [{ item: 0, qty: 3000, markup: 1.34 }, { item: 1, qty: 2400, markup: 1.35 }], settle: 'none' },
    ],
    expensesLocal: [
      { amount: 21000, daysAgo: 58, description: 'Warehouse rent — quarter' },
      { amount: 5400, daysAgo: 33, description: 'Quality inspection and cupping' },
    ],
    logistics: true,
  },
  {
    key: 'apparel',
    label: 'Apparel',
    company: {
      name: 'Threadline Apparel Exports (Pvt) Ltd',
      legalName: 'THREADLINE APPAREL EXPORTS (PVT) LTD',
      country: 'Pakistan',
      template: 'APPAREL_TEXTILE',
      tagline: 'Knitwear made to order',
      address: 'Plot 14, Demo Industrial Estate, Karachi',
      phone: '+92 21 0000 0000',
      email: 'exports@threadline.example',
      website: 'www.threadline.example',
      registration: 'DEMO-NTN-0000000',
    },
    rates: { PKR: '280.0000', EUR: '0.9200', GBP: '0.7900' },
    transactionCurrencies: ['PKR', 'USD', 'EUR', 'GBP'],
    salesCurrencies: ['USD', 'EUR', 'GBP'],
    defaultSalesCurrency: 'USD',
    warehouses: [
      { name: 'Finished Goods Store', location: 'Karachi', port: 'Karachi' },
      { name: 'Fabric Store', location: 'Karachi' },
    ],
    vendors: [
      { name: 'Lahore Fabric Mills', country: 'Pakistan', currency: 'USD', terms: 30, contact: 'Imran Demo', email: 'sales@lahorefabric.example' },
      { name: 'Dhaka Trims & Labels', country: 'Bangladesh', currency: 'USD', terms: 45, contact: 'Rafiq Demo', email: 'info@dhakatrims.example' },
    ],
    customers: [
      { name: 'Nordic Basics ApS', country: 'Denmark', currency: 'EUR', terms: 45, contact: 'Mette Demo', email: 'buying@nordicbasics.example' },
      { name: 'Highstreet Threads Ltd', country: 'United Kingdom', currency: 'GBP', terms: 30, contact: 'Oliver Demo', email: 'orders@highstreetthreads.example' },
      { name: 'Pacific Wear Inc', country: 'United States', currency: 'USD', terms: 60, contact: 'Jordan Demo', email: 'po@pacificwear.example' },
    ],
    items: [
      { name: 'Cotton polo shirt — navy', sku: 'POLO-NVY', category: 'Tops', brand: 'Threadline', baseUom: 'PCS', packUom: 'CTN', packSize: 48, hsCode: '6105.10', origin: 'Pakistan', costUsd: 3.4, attributes: { size: 'S–XL', color: 'Navy', fabric: '100% combed cotton', gsm: '200' } },
      { name: 'Fleece hoodie — charcoal', sku: 'HOOD-CHR', category: 'Outerwear', brand: 'Threadline', baseUom: 'PCS', packUom: 'CTN', packSize: 24, hsCode: '6110.20', origin: 'Pakistan', costUsd: 7.8, attributes: { size: 'S–XXL', color: 'Charcoal', fabric: 'Cotton-poly fleece', gsm: '320' } },
      { name: 'Jersey knit fabric — white', sku: 'FAB-JER-WH', category: 'Fabric', baseUom: 'M', packUom: 'ROLL', packSize: 100, hsCode: '6006.21', origin: 'Pakistan', costUsd: 2.1, attributes: { color: 'White', fabric: 'Single jersey', gsm: '180' } },
    ],
    purchases: [
      { vendor: 0, daysAgo: 100, lines: [{ item: 2, qty: 20000 }], freightUsd: 0, receivedDaysAgo: 92, warehouse: 1, paidShare: 1 },
      { vendor: 0, daysAgo: 60, lines: [{ item: 0, qty: 15000 }, { item: 1, qty: 6000 }], freightUsd: 1800, receivedDaysAgo: 40, warehouse: 0, clearingLocal: 120000, paidShare: 0.7 },
      { vendor: 1, daysAgo: 15, lines: [{ item: 0, qty: 9000 }], freightUsd: 900, receivedDaysAgo: null, warehouse: 0 },
    ],
    sales: [
      { customer: 0, daysAgo: 38, currency: 'EUR', lines: [{ item: 0, qty: 6000, markup: 1.55 }, { item: 1, qty: 2400, markup: 1.5 }], settle: 'full' },
      { customer: 1, daysAgo: 26, currency: 'GBP', lines: [{ item: 0, qty: 4800, markup: 1.52 }], settle: 'part' },
      { customer: 2, daysAgo: 12, currency: 'USD', lines: [{ item: 1, qty: 2000, markup: 1.48 }], settle: 'none' },
    ],
    expensesLocal: [
      { amount: 450000, daysAgo: 50, description: 'Factory overhead — month' },
      { amount: 96000, daysAgo: 20, description: 'Sampling and courier' },
    ],
    logistics: true,
  },
  {
    key: 'distribution',
    label: 'Distribution',
    company: {
      name: 'Metro Distribution Co Ltd',
      legalName: 'METRO DISTRIBUTION CO LTD',
      country: 'United Kingdom',
      template: 'DISTRIBUTION',
      tagline: 'Everyday essentials, on time',
      address: 'Unit 8, Demo Trade Park, Birmingham',
      phone: '+44 121 000 0000',
      email: 'orders@metrodistribution.example',
      website: 'www.metrodistribution.example',
      registration: 'DEMO-CRN-00000000',
    },
    rates: { GBP: '0.7900', EUR: '0.9200' },
    transactionCurrencies: ['GBP', 'USD', 'EUR'],
    salesCurrencies: ['GBP'],
    defaultSalesCurrency: 'GBP',
    tax: { registration: 'DEMO-GB-000000000', label: 'VAT', ratePct: '20' },
    warehouses: [
      { name: 'Birmingham Depot', location: 'Birmingham' },
      { name: 'Leeds Store', location: 'Leeds' },
    ],
    vendors: [
      { name: 'Midlands Packaging Supplies', country: 'United Kingdom', currency: 'GBP', terms: 30, contact: 'Helen Demo', email: 'sales@midlandspack.example' },
      { name: 'Northern Foods Wholesale', country: 'United Kingdom', currency: 'GBP', terms: 21, contact: 'Peter Demo', email: 'trade@northernfoods.example' },
    ],
    customers: [
      { name: 'Corner Shop Collective', country: 'United Kingdom', currency: 'GBP', terms: 14, contact: 'Amira Demo', email: 'orders@cornershop.example' },
      { name: 'Riverside Cafés Group', country: 'United Kingdom', currency: 'GBP', terms: 30, contact: 'Tom Demo', email: 'purchasing@riversidecafes.example' },
    ],
    items: [
      { name: 'Paper cups 8oz (carton of 1000)', sku: 'CUP-8OZ', category: 'Packaging', baseUom: 'PCS', packUom: 'CTN', packSize: 1000, hsCode: '4823.69', origin: 'United Kingdom', costUsd: 0.025 },
      { name: 'Kitchen roll 2-ply (case of 24)', sku: 'ROLL-2P', category: 'Hygiene', baseUom: 'PCS', packUom: 'CTN', packSize: 24, hsCode: '4818.20', origin: 'United Kingdom', costUsd: 0.9 },
      { name: 'Olive oil 5L', sku: 'OIL-OLV-5L', category: 'Food', baseUom: 'PCS', packUom: 'CTN', packSize: 4, hsCode: '1509.20', origin: 'Spain', costUsd: 21 },
    ],
    purchases: [
      { vendor: 0, daysAgo: 80, lines: [{ item: 0, qty: 500000 }, { item: 1, qty: 20000 }], freightUsd: 0, receivedDaysAgo: 74, warehouse: 0, paidShare: 1 },
      { vendor: 1, daysAgo: 40, lines: [{ item: 2, qty: 1200 }], freightUsd: 0, receivedDaysAgo: 35, warehouse: 1, paidShare: 0.5 },
      { vendor: 0, daysAgo: 8, lines: [{ item: 1, qty: 15000 }], freightUsd: 0, receivedDaysAgo: 4, warehouse: 0 },
    ],
    sales: [
      { customer: 0, daysAgo: 60, currency: 'GBP', lines: [{ item: 0, qty: 120000, markup: 1.3 }, { item: 1, qty: 4000, markup: 1.32 }], settle: 'full' },
      { customer: 1, daysAgo: 30, currency: 'GBP', lines: [{ item: 2, qty: 300, markup: 1.28 }], settle: 'part' },
      { customer: 0, daysAgo: 9, currency: 'GBP', lines: [{ item: 1, qty: 6000, markup: 1.31 }], settle: 'none' },
    ],
    expensesLocal: [
      { amount: 3800, daysAgo: 45, description: 'Depot rent — month' },
      { amount: 650, daysAgo: 12, description: 'Van fuel' },
    ],
    logistics: false,
  },
];
