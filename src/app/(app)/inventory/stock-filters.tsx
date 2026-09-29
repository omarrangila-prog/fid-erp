import Form from 'next/form';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/field';

export type StockFilterValues = {
  item?: string;
  warehouse?: string;
  shipment?: string;
  batch?: string;
  container?: string;
  from?: string;
  to?: string;
};

type Option = { id: string; label: string };

/**
 * The Stock on Hand filters. They live in the URL, so a filtered view can be
 * bookmarked, shared or refreshed, and the server applies them to every figure
 * on the page — the cards, the table and the item page it opens — not just to
 * the rows on screen.
 */
export function StockFilters({
  action,
  values,
  items,
  warehouses,
  shipments,
  batches,
  containers,
  showItem = true,
}: {
  action: string;
  values: StockFilterValues;
  items: Option[];
  warehouses: Option[];
  shipments: Option[];
  batches: Option[];
  containers: Option[];
  showItem?: boolean;
}) {
  const active = Object.entries(values).some(([key, value]) => value && (showItem || key !== 'item'));
  const select = (name: keyof StockFilterValues, label: string, options: Option[]) => (
    <Field label={label} htmlFor={`stock-${name}`} className="min-w-40 flex-1 sm:flex-none">
      <Select id={`stock-${name}`} name={name} defaultValue={values[name] ?? ''} className="h-10">
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  );

  return (
    <Form action={action} className="flex flex-wrap items-end gap-3 print:hidden" data-testid="stock-filters">
      {showItem ? select('item', 'Item', items) : null}
      {select('warehouse', 'Warehouse', warehouses)}
      {select('shipment', 'Shipment', shipments)}
      {select('container', 'Container', containers)}
      {select('batch', 'Batch', batches)}
      <Field label="From" htmlFor="stock-from" className="w-40">
        <Input id="stock-from" type="date" name="from" defaultValue={values.from ?? ''} />
      </Field>
      <Field label="To" htmlFor="stock-to" className="w-40">
        <Input id="stock-to" type="date" name="to" defaultValue={values.to ?? ''} />
      </Field>
      <Button type="submit" variant="outline">
        Apply
      </Button>
      {active ? (
        <Button variant="ghost" asChild>
          <Link href={action}>Clear</Link>
        </Button>
      ) : null}
    </Form>
  );
}
