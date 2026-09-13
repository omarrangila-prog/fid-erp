-- Cash sale or credit sale, said on the invoice.
--
-- A cash sale is settled the moment it is raised: the customer pays over the
-- counter and walks out. Recording it as a credit sale and then remembering to
-- key a separate receipt is two entries for one event, and the second one gets
-- forgotten.
--
-- The invoice therefore carries the intent, and posting a cash sale raises the
-- receipt with it. CREDIT is the default because it is what an invoice is
-- unless somebody says otherwise.

CREATE TYPE "SalePaymentType" AS ENUM ('CASH', 'CREDIT');

ALTER TABLE "sales_invoices" ADD COLUMN "paymentType" "SalePaymentType" NOT NULL DEFAULT 'CREDIT';

-- Which account the cash went into. Only meaningful for a cash sale.
ALTER TABLE "sales_invoices" ADD COLUMN "cashBankAccountId" TEXT;
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_cashBankAccountId_fkey"
  FOREIGN KEY ("cashBankAccountId") REFERENCES "cash_bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
