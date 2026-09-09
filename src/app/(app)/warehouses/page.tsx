import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getWarehouseStock } from '@/lib/services/dashboard';
import { formatQuantityKg, formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { SimpleMasterTable, type SimpleRow, type SimpleColumnSpec } from '@/components/shared/simple-master';
import { STATUS_OPTIONS, type FieldSpec } from '@/components/shared/master-form';
import { saveWarehouseAction } from '@/server/actions/master-actions';

export const metadata: Metadata = { title: 'Warehouses' };
export const dynamic = 'force-dynamic';

const FIELDS: FieldSpec[] = [
  { kind: 'text', name: 'code', label: 'Warehouse code', required: true, placeholder: 'MA-CASA-A' },
  { kind: 'text', name: 'name', label: 'Warehouse name', required: true, placeholder: 'Casablanca Warehouse A' },
  { kind: 'text', name: 'location', label: 'Location', placeholder: 'Casablanca' },
  { kind: 'text', name: 'country', label: 'Country' },
  { kind: 'text', name: 'port', label: 'Linked port', placeholder: 'Casablanca' },
  { kind: 'select', name: 'status', label: 'Status', options: STATUS_OPTIONS },
  {
    kind: 'checkbox',
    name: 'isDefault',
    label: 'Default receiving warehouse',
    hint: 'Pre-selected on new goods receipts.',
    full: true,
  },
];

const COLUMNS: SimpleColumnSpec[] = [
  { id: 'name', header: 'Warehouse', key: 'name', mobile: 'title' },
  { id: 'code', header: 'Code', key: 'code', mobile: 'meta' },
  { id: 'location', header: 'Location', key: 'location', mobile: 'meta' },
  { id: 'port', header: 'Port', key: 'port', hideable: true },
  { id: 'stock', header: 'On hand', key: 'stock', kind: 'number', mobile: 'meta' },
  { id: 'bags', header: 'Bags', key: 'bags', kind: 'number', hideable: true },
  { id: 'value', header: 'Stock value', key: 'value', kind: 'number', hideable: true },
  {
    id: 'status',
    header: 'Status',
    key: 'status',
    kind: 'badge',
    mobile: 'badge',
    tones: { Active: 'success', Inactive: 'neutral', Default: 'info' },
  },
];

export default async function WarehousesPage() {
  const user = await requirePageAccess(PERMISSIONS.WAREHOUSES_VIEW);
  const companyId = user.activeCompany.id;
  const showValue = can(user, PERMISSIONS.PURCHASE_COST_VIEW);

  const [warehouses, stock] = await Promise.all([
    prisma.warehouse.findMany({ where: { companyId }, orderBy: { name: 'asc' } }),
    getWarehouseStock(companyId),
  ]);

  const stockByWarehouse = new Map(stock.map((s) => [s.warehouseId, s]));

  const rows: SimpleRow[] = warehouses.map((w) => {
    const s = stockByWarehouse.get(w.id);
    return {
      id: w.id,
      title: w.name,
      searchText: `${w.name} ${w.code} ${w.location ?? ''} ${w.port ?? ''}`,
      data: {
        name: w.name,
        code: w.code,
        location: w.location,
        port: w.port,
        stock: s ? formatQuantityKg(s.onHandKg) : '0 KG',
        bags: s ? s.bags.toLocaleString() : '0',
        value: showValue && s ? formatMoney(s.valueUsd, 'USD') : '—',
        status: w.status === 'ACTIVE' ? (w.isDefault ? 'Default' : 'Active') : 'Inactive',
      },
      formValues: {
        code: w.code,
        name: w.name,
        location: w.location,
        country: w.country,
        port: w.port,
        isDefault: w.isDefault,
        status: w.status,
      },
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Warehouses"
        description="Stock is held per warehouse. A goods receipt must name one, and sales deplete the warehouse they are sold from."
        breadcrumbs={[{ label: 'Masters' }, { label: 'Warehouses' }]}
      />
      <SimpleMasterTable
        rows={rows}
        columns={COLUMNS}
        fields={FIELDS}
        createDefaults={{ status: 'ACTIVE', country: user.activeCompany.code === 'FID-MA' ? 'Morocco' : 'United Arab Emirates' }}
        action={saveWarehouseAction}
        entityLabel="Warehouse"
        canCreate={can(user, PERMISSIONS.WAREHOUSES_MANAGE)}
        canEdit={can(user, PERMISSIONS.WAREHOUSES_MANAGE)}
        emptyDescription="Add the physical locations where coffee is stored."
        searchPlaceholder="Search warehouses…"
      />
    </div>
  );
}
