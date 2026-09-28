import 'server-only';
import { notFound } from 'next/navigation';
import type { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { ForbiddenError } from '@/lib/errors';
import { prisma } from '@/lib/db';

/**
 * Whose data a person sees.
 *
 * Permissions say what someone may do; scope says to which records. An agent
 * signing in for himself is linked to his agent record, and from then on:
 *
 *   his ledger        only his own agent page
 *   customers         the customers who are his (customer.agentId)
 *   invoices          invoices to his customers, or that he raised
 *   collections       receipts collected by him, for his customers, or that he entered
 *   payments          payments he entered
 *   warehouses        the warehouses assigned to him, when any are
 *
 * These are filters on the server — in the query itself and in every action
 * that saves or changes a record — not hidden buttons. A record outside his
 * scope is "not found" to him, exactly as a record in another company is.
 *
 * Super Admins are never narrowed, and a user with no agent linked sees what
 * their permissions allow, as before.
 */

export function agentScope(user: SessionUser): string | null {
  return user.isSuperAdmin ? null : user.scope.agentId;
}

export function warehouseScope(user: SessionUser): string[] | null {
  return user.isSuperAdmin || user.scope.warehouseIds.length === 0 ? null : user.scope.warehouseIds;
}

export function isScoped(user: SessionUser): boolean {
  return agentScope(user) !== null || warehouseScope(user) !== null;
}

export function customerScopeWhere(user: SessionUser): Prisma.CustomerWhereInput {
  const agentId = agentScope(user);
  return agentId ? { agentId } : {};
}

export function invoiceScopeWhere(user: SessionUser): Prisma.SalesInvoiceWhereInput {
  const agentId = agentScope(user);
  return agentId ? { OR: [{ customer: { agentId } }, { createdById: user.id }] } : {};
}

export function receiptScopeWhere(user: SessionUser): Prisma.ReceiptWhereInput {
  const agentId = agentScope(user);
  return agentId ? { OR: [{ agentId }, { customer: { agentId } }, { createdById: user.id }] } : {};
}

export function paymentScopeWhere(user: SessionUser): Prisma.PaymentWhereInput {
  return agentScope(user) ? { createdById: user.id } : {};
}

export function warehouseScopeWhere(user: SessionUser): Prisma.WarehouseWhereInput {
  const ids = warehouseScope(user);
  return ids ? { id: { in: ids } } : {};
}

/** On a page: another agent's record is simply not there. */
export function assertAgentVisible(user: SessionUser, agentId: string): void {
  const own = agentScope(user);
  if (own && own !== agentId) notFound();
}

/** In an action: a record outside the person's scope is refused. */
export function assertInScope(inScope: boolean, what = 'record'): void {
  if (!inScope) throw new ForbiddenError(`This ${what} is not yours to change.`);
}

// ---------------------------------------------------------------------------
// In actions: the record a person is saving, posting or deleting must be in
// their scope. Queried here rather than trusted from the form.
// ---------------------------------------------------------------------------

export async function assertCustomerInScope(user: SessionUser, customerId: string): Promise<void> {
  const agentId = agentScope(user);
  if (!agentId) return;
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId: user.activeCompany.id, agentId },
    select: { id: true },
  });
  assertInScope(Boolean(customer), 'customer');
}

export async function assertInvoiceInScope(user: SessionUser, invoiceId: string): Promise<void> {
  if (!agentScope(user)) return;
  const invoice = await prisma.salesInvoice.findFirst({
    where: { id: invoiceId, companyId: user.activeCompany.id, ...invoiceScopeWhere(user) },
    select: { id: true },
  });
  assertInScope(Boolean(invoice), 'invoice');
}

export async function assertReceiptInScope(user: SessionUser, receiptId: string): Promise<void> {
  if (!agentScope(user)) return;
  const receipt = await prisma.receipt.findFirst({
    where: { id: receiptId, companyId: user.activeCompany.id, ...receiptScopeWhere(user) },
    select: { id: true },
  });
  assertInScope(Boolean(receipt), 'collection');
}

export async function assertPaymentInScope(user: SessionUser, paymentId: string): Promise<void> {
  if (!agentScope(user)) return;
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, companyId: user.activeCompany.id, createdById: user.id },
    select: { id: true },
  });
  assertInScope(Boolean(payment), 'payment');
}

export function assertWarehousesInScope(user: SessionUser, warehouseIds: Array<string | null | undefined>): void {
  const allowed = warehouseScope(user);
  if (!allowed) return;
  for (const id of warehouseIds) if (id && !allowed.includes(id)) assertInScope(false, 'warehouse');
}
