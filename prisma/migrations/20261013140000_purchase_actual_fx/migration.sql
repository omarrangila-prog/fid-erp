-- The rate actually paid for the dollars, once it is known.
--
-- An order is placed in USD at the best rate available that day, which is an
-- estimate: the real rate appears later, when the dollars are bought to pay
-- the supplier. Costing has been using the estimate for the life of the
-- shipment, so every local figure — landed cost, cost per KG, inventory value,
-- cost of sales — was stated at a rate nobody paid.
--
-- The USD purchase price never changes. Only the local translation does.
--
-- Additive only: four nullable columns. Every existing order reads as "still
-- the estimate", which is what it is, and no row is rewritten.
ALTER TABLE "purchase_contracts"
  ADD COLUMN "actualRateLocalPerUsd" DECIMAL(18,8),
  ADD COLUMN "actualRateSetAt" TIMESTAMP(3),
  ADD COLUMN "actualRateSetById" TEXT,
  ADD COLUMN "actualRateNote" TEXT;

