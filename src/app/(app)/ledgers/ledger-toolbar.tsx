'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import Link from 'next/link';
import { ChevronDown, Download, FileSpreadsheet, FileText, Printer, Share2, Plus } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { exportHref } from '@/components/shared/excel-link';

export function LedgerToolbar({
  basePath,
  printPath,
  exportReport,
  customerId,
  vendorId,
  view,
  currency,
  from,
  to,
  kind,
}: {
  basePath: string;
  printPath: string;
  exportReport: string;
  customerId?: string;
  vendorId?: string;
  view: string;
  currency?: string;
  from: string;
  to: string;
  kind: string;
}) {
  const router = useRouter();
  const [fromDate, setFrom] = React.useState(from);
  const [toDate, setTo] = React.useState(to);
  const [kindValue, setKind] = React.useState(kind || 'ALL');

  const filters = {
    view,
    currency,
    from: fromDate,
    to: toDate,
    kind: kindValue === 'ALL' ? undefined : kindValue,
    customer: customerId,
    vendor: vendorId,
  };

  function apply(path = basePath) {
    const params = new URLSearchParams();
    if (currency) params.set('currency', currency);
    else if (view) params.set('view', view);
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);
    if (kindValue && kindValue !== 'ALL') params.set('kind', kindValue);
    const suffix = params.toString();
    router.push(`${path}${suffix ? `?${suffix}` : ''}`);
  }

  const printHref = (() => {
    const params = new URLSearchParams();
    if (currency) params.set('currency', currency);
    else if (view) params.set('view', view);
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);
    if (kindValue && kindValue !== 'ALL') params.set('kind', kindValue);
    params.set('print', '1');
    return `${printPath}?${params.toString()}`;
  })();

  const excelHref = exportHref(exportReport, filters);
  const csvHref = exportHref(exportReport, { ...filters, format: 'csv' });

  async function share() {
    const url = new URL(printHref, window.location.origin).toString();
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Account statement', url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast.success('Statement link copied.');
    } catch {
      toast.error('Sharing was cancelled.');
    }
  }

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between" data-print="hide">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="From" className="w-40">
          <Input type="date" value={fromDate} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To" className="w-40">
          <Input type="date" value={toDate} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Show" className="w-44">
          <Select value={kindValue} onChange={(e) => setKind(e.target.value)}>
            <option value="ALL">All transactions</option>
            <option value="INVOICES">Invoices</option>
            <option value="PAYMENTS">Payments</option>
          </Select>
        </Field>
        <Button variant="outline" onClick={() => apply()}>
          Show
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/*
          Starting the transaction the ledger just made you think of, without
          leaving the ledger. A customer's page offers an invoice and a
          receipt; a supplier's a contract and a payment; both a journal.
        */}
        {customerId ? (
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={`/sales/new?customer=${customerId}`}>
                <Plus />
                Invoice
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/finance/receipts/new?customer=${customerId}`}>
                <Plus />
                Receipt
              </Link>
            </Button>
          </>
        ) : null}
        {vendorId ? (
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={`/purchases/new?vendor=${vendorId}`}>
                <Plus />
                Contract
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/finance/payments/new?vendor=${vendorId}`}>
                <Plus />
                Payment
              </Link>
            </Button>
          </>
        ) : null}
        <Button asChild variant="outline" size="sm">
          <Link href="/accounting/journal/new">
            <Plus />
            Journal entry
          </Link>
        </Button>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button variant="outline" size="sm">
              <Download />
              Export
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              className="z-50 min-w-44 rounded-lg border border-line bg-surface p-1 shadow-xl"
            >
              <DropdownMenu.Item asChild>
                <a
                  href={printHref}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-ink outline-none hover:bg-forest-50"
                >
                  <FileText className="size-4" />
                  PDF
                </a>
              </DropdownMenu.Item>
              <DropdownMenu.Item asChild>
                <a
                  href={excelHref}
                  download
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-ink outline-none hover:bg-forest-50"
                >
                  <FileSpreadsheet className="size-4" />
                  Excel
                </a>
              </DropdownMenu.Item>
              <DropdownMenu.Item asChild>
                <a
                  href={csvHref}
                  download
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-ink outline-none hover:bg-forest-50"
                >
                  <Download className="size-4" />
                  CSV
                </a>
              </DropdownMenu.Item>
              <DropdownMenu.Item asChild>
                <a
                  href={printHref}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-ink outline-none hover:bg-forest-50"
                >
                  <Printer className="size-4" />
                  Print
                </a>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <Button variant="outline" size="sm" asChild>
          <a href={printHref}>
            <FileText />
            Download PDF
          </a>
        </Button>
        <Button variant="outline" size="sm" onClick={share}>
          <Share2 />
          Share PDF
        </Button>
      </div>
    </div>
  );
}
