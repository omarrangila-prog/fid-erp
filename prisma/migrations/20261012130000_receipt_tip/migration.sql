-- Money received over and above the invoices a receipt pays.
--
-- It already became an advance on the customer's account. Now the user may
-- instead say the customer told us to keep it, which makes it income.
--
-- Additive only: every existing receipt reads as ADVANCE, which is what it
-- was, and no row is rewritten.
CREATE TYPE "ReceiptOverpayment" AS ENUM ('ADVANCE', 'TIP');

ALTER TABLE "receipts"
  ADD COLUMN "overpayment" "ReceiptOverpayment" NOT NULL DEFAULT 'ADVANCE',
  ADD COLUMN "tipReason" TEXT;
