'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { FilterBar, FilterCell, FilterSelect } from '@/components/shared/filter-bar';

type Option = { value: string; label: string };

/**
 * The narrowing the PDF asks for: by party, by job, by currency, by kind of
 * account. Each is a plain select that rewrites the address, so a filtered
 * trial balance is a link that can be sent to somebody.
 */
export function TrialBalanceFilters({
  customers,
  vendors,
  shipments,
  warehouses,
  currencies,
}: {
  customers: Option[];
  vendors: Option[];
  shipments: Option[];
  warehouses: Option[];
  currencies: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function set(key: string, value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`${pathname}?${next.toString()}`);
  }

  const control = (key: string, label: string, options: Option[], all: string) => (
    <FilterCell label={label} htmlFor={`tb-${key}`} className="md:min-w-40 md:flex-1">
      <FilterSelect id={`tb-${key}`} value={searchParams.get(key) ?? ''} onChange={(e) => set(key, e.target.value)}>
        <option value="">{all}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </FilterSelect>
    </FilterCell>
  );

  return (
    <FilterBar>
      {control('type', 'Account category', [
        { value: 'ASSET', label: 'Assets' },
        { value: 'LIABILITY', label: 'Liabilities' },
        { value: 'EQUITY', label: 'Equity' },
        { value: 'INCOME', label: 'Income' },
        { value: 'EXPENSE', label: 'Expenses' },
      ], 'All categories')}
      {control('currency', 'Currency', currencies.map((c) => ({ value: c, label: c })), 'All currencies')}
      {control('customer', 'Customer', customers, 'All customers')}
      {control('vendor', 'Supplier', vendors, 'All suppliers')}
      {control('warehouse', 'Warehouse', warehouses, 'All warehouses')}
      {control('shipment', 'Shipment', shipments, 'All shipments')}
    </FilterBar>
  );
}
