-- Lot and batch numbers become known when the goods are loaded, not when the
-- contract is signed.
--
-- The client was explicit: at contract stage the supplier has not yet
-- identified the physical coffee, so demanding a lot number before saving a
-- purchase order made people invent one. The numbers arrive with the goods,
-- which is where the system now asks for them — and where at least one of the
-- two becomes mandatory, because stock traceability starts at receipt.
--
-- Permissive only: existing rows keep the numbers they have.

ALTER TABLE "purchase_contract_lines" ALTER COLUMN "lotNumber" DROP NOT NULL;
ALTER TABLE "purchase_contract_lines" ALTER COLUMN "batchNumber" DROP NOT NULL;

-- True when the batch carries a placeholder identity issued by the system
-- rather than a real supplier lot, so the goods receipt knows to ask.
ALTER TABLE "batches" ADD COLUMN "traceabilityPending" BOOLEAN NOT NULL DEFAULT false;

-- A goods receipt line may name the lot and batch the coffee actually arrived
-- under, and may split one contract line across several of them: 42 MT ordered
-- can land as 21 MT under lot 120229 and 21 MT under lot 120230.
ALTER TABLE "goods_receipt_lines" ADD COLUMN "lotNumber" TEXT;
ALTER TABLE "goods_receipt_lines" ADD COLUMN "batchNumber" TEXT;
ALTER TABLE "goods_receipt_lines" ADD COLUMN "containerNumber" TEXT;
