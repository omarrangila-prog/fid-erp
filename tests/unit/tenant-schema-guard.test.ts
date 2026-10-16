import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A new table must declare whose it is.
 *
 * Every model either carries `companyId`, or is on the list below with the
 * reason it does not. Adding a model to the schema without doing one of those
 * fails here — which is the point: tenant isolation is lost one forgotten
 * column at a time.
 */
const WITHOUT_COMPANY: Record<string, string> = {
  // The tenancy tree itself.
  Organization: 'the tenant root',
  Company: 'is the company',
  CompanyLogo: 'one row per company; its primary key is the companyId',
  // Identity and access are shared infrastructure; membership is in UserCompany.
  User: 'a person; reaches companies through UserCompany and an organization',
  Session: 'carries activeCompanyId',
  Role: 'system roles are shared; custom roles belong to an organization',
  Permission: 'the global permission catalogue',
  RolePermission: 'child of Role',
  UserRole: 'child of User and Role',
  // Child rows, always reached through a company-scoped parent.
  PurchaseContractLine: 'child of PurchaseContract',
  ShipmentStatusHistory: 'child of Shipment',
  ShipmentDocumentStatusHistory: 'child of Shipment',
  GoodsReceiptLine: 'child of GoodsReceipt',
  StockTransferLine: 'child of StockTransfer',
  SalesInvoiceLine: 'child of SalesInvoice',
  ReceiptAllocation: 'child of Receipt',
  PaymentAllocation: 'child of Payment',
  ChequeStatusHistory: 'child of Cheque',
  JournalLine: 'child of JournalEntry',
  CreditNoteLine: 'child of CreditNote',
  StockCountLine: 'child of StockCount',
  OverheadAllocationLine: 'child of OverheadAllocation',
  ExpenseBatchShare: 'child of Expense',
};

function models(): Array<{ name: string; body: string }> {
  const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
  return [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({ name: m[1], body: m[2] }));
}

describe('tenant isolation: every table says whose it is', () => {
  it('has companyId on every model not explicitly exempted', () => {
    const offenders = models()
      .filter((m) => !/^\s+companyId\s/m.test(m.body) && !(m.name in WITHOUT_COMPANY))
      .map((m) => m.name);
    expect(offenders, `Add companyId to these models, or list them in WITHOUT_COMPANY with a reason: ${offenders.join(', ')}`).toEqual([]);
  });

  it('does not exempt a model that has since gained a companyId or no longer exists', () => {
    const byName = new Map(models().map((m) => [m.name, m.body]));
    const stale = Object.keys(WITHOUT_COMPANY).filter((name) => !byName.has(name));
    expect(stale, `Remove from WITHOUT_COMPANY: ${stale.join(', ')}`).toEqual([]);
  });

  it('cascades a company’s data away with the company', () => {
    // A tenant that is deleted must take its rows with it, never orphan them.
    const bad = models()
      .filter((m) => /^\s+companyId\s+String\s*$/m.test(m.body))
      .filter((m) => !/fields: \[companyId\], references: \[id\], onDelete: Cascade/.test(m.body))
      .map((m) => m.name);
    expect(bad, `companyId without a cascading relation: ${bad.join(', ')}`).toEqual([]);
  });
});
