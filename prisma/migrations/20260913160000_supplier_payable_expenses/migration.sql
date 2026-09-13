-- A cost owed to a supplier is a payable like any other.
--
-- Posting an expense with a supplier instead of a cash account credits
-- Accounts Payable, but the payables list was built only from purchase
-- contracts, so the bill never reached the supplier's statement, the ageing,
-- or the payment screen. The control account and the sub-ledger disagreed by
-- exactly the amount of every such bill.
--
-- A payment allocation now points at either a purchase contract or an expense,
-- never both and never neither.

ALTER TABLE "payment_allocations" ALTER COLUMN "purchaseContractId" DROP NOT NULL;
ALTER TABLE "payment_allocations" ADD COLUMN "expenseId" TEXT;

ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "payment_allocations_one_target"
  CHECK (num_nonnulls("purchaseContractId", "expenseId") = 1);

ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "payment_allocations_expenseId_fkey"
  FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "payment_allocations_paymentId_expenseId_key"
  ON "payment_allocations"("paymentId", "expenseId");

CREATE INDEX "payment_allocations_expenseId_idx" ON "payment_allocations"("expenseId");
