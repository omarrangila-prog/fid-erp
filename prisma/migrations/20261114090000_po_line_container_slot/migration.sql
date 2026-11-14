-- One container, several coffees.
--
-- A purchase-order line is a coffee; the physical container it travels in is
-- now its own fact. Lines sharing a slot are loaded in the same box, so a
-- container with two items counts once, ships once and is costed once.
--
-- Additive only: a nullable column. Existing lines keep NULL and are read
-- exactly as before — each its own container — until an order is edited.
ALTER TABLE "purchase_contract_lines" ADD COLUMN IF NOT EXISTS "containerSlot" INTEGER;
