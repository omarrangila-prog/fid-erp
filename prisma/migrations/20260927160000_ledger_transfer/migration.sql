-- Settling a receipt, payment or cost ledger to ledger.
--
-- Beside cash, bank and cheque, money can be settled against another ledger
-- account — a person's account, a loan, the other FID company — with no cash
-- or bank account moving. The account on the other side is recorded on the
-- document. Additive only: every existing row keeps its method and account,
-- and the new column is empty on all of them.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'LEDGER_TRANSFER';

ALTER TABLE "receipts" ADD COLUMN "ledgerAccountId" TEXT;
ALTER TABLE "payments" ADD COLUMN "ledgerAccountId" TEXT;
ALTER TABLE "expenses" ADD COLUMN "ledgerAccountId" TEXT;

CREATE INDEX "receipts_ledgerAccountId_idx" ON "receipts"("ledgerAccountId");
CREATE INDEX "payments_ledgerAccountId_idx" ON "payments"("ledgerAccountId");
CREATE INDEX "expenses_ledgerAccountId_idx" ON "expenses"("ledgerAccountId");

ALTER TABLE "receipts" ADD CONSTRAINT "receipts_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
