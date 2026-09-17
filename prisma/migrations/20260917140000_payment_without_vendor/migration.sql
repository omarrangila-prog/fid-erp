-- A payment that settles an accrued cost has no supplier.
--
-- An unpaid expense no longer has to name who it is owed to: it is booked to
-- Accrued Expenses and paid later, from cash or bank, with no supplier on the
-- payment either. The column becomes nullable; every existing payment keeps
-- its supplier and nothing else changes.
ALTER TABLE "payments" ALTER COLUMN "vendorId" DROP NOT NULL;
