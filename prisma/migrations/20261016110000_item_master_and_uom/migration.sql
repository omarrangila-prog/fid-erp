-- Productization step 2: an industry-independent item master and flexible
-- units of measure. Additive: every existing coffee item keeps every value.

ALTER TYPE "UnitOfMeasure" ADD VALUE IF NOT EXISTS 'PCS';
ALTER TYPE "UnitOfMeasure" ADD VALUE IF NOT EXISTS 'DOZ';
ALTER TYPE "UnitOfMeasure" ADD VALUE IF NOT EXISTS 'CTN';
ALTER TYPE "UnitOfMeasure" ADD VALUE IF NOT EXISTS 'BOX';
ALTER TYPE "UnitOfMeasure" ADD VALUE IF NOT EXISTS 'ROLL';
ALTER TYPE "UnitOfMeasure" ADD VALUE IF NOT EXISTS 'PLT';
ALTER TYPE "UnitOfMeasure" ADD VALUE IF NOT EXISTS 'PACK';
ALTER TYPE "UnitOfMeasure" ADD VALUE IF NOT EXISTS 'M';
ALTER TYPE "UnitOfMeasure" ADD VALUE IF NOT EXISTS 'L';

-- Coffee-only facts stop being mandatory (values and defaults of existing rows are untouched).
ALTER TABLE "coffee_items" ALTER COLUMN "coffeeType" DROP NOT NULL;
ALTER TABLE "coffee_items" ALTER COLUMN "coffeeType" DROP DEFAULT;
ALTER TABLE "coffee_items" ALTER COLUMN "originCountry" DROP NOT NULL;
ALTER TABLE "coffee_items" ALTER COLUMN "process" DROP NOT NULL;
ALTER TABLE "coffee_items" ALTER COLUMN "process" DROP DEFAULT;
ALTER TABLE "coffee_items" ALTER COLUMN "packagingType" DROP NOT NULL;
ALTER TABLE "coffee_items" ALTER COLUMN "packagingType" DROP DEFAULT;

ALTER TABLE "coffee_items"
ADD COLUMN "baseUom" VARCHAR(8) NOT NULL DEFAULT 'KG',
ADD COLUMN "packUom" VARCHAR(8) NOT NULL DEFAULT 'BAG',
ADD COLUMN "salesUom" VARCHAR(8),
ADD COLUMN "category" TEXT,
ADD COLUMN "brand" TEXT,
ADD COLUMN "hsCode" VARCHAR(16),
ADD COLUMN "taxCategory" TEXT,
ADD COLUMN "unitWeightKg" DECIMAL(18,6),
ADD COLUMN "attributes" JSONB NOT NULL DEFAULT '{}';
