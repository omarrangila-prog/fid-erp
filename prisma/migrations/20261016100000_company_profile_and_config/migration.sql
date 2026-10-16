-- Productization step 1: company identity, localisation, business shape and an
-- Organization above Company. Purely additive; every existing row keeps its
-- behaviour (defaults reproduce what the code did before).

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan" VARCHAR(24) NOT NULL DEFAULT 'ENTERPRISE',
    "authPolicy" VARCHAR(24) NOT NULL DEFAULT 'PASSWORD',
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_logos" (
    "companyId" TEXT NOT NULL,
    "mimeType" VARCHAR(32) NOT NULL,
    "bytes" BYTEA NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_logos_pkey" PRIMARY KEY ("companyId")
);

-- AddForeignKey
ALTER TABLE "company_logos" ADD CONSTRAINT "company_logos_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "companies"
ADD COLUMN "tradingName" TEXT,
ADD COLUMN "tagline" TEXT,
ADD COLUMN "phone" TEXT,
ADD COLUMN "email" TEXT,
ADD COLUMN "website" TEXT,
ADD COLUMN "companyRegistration" TEXT,
ADD COLUMN "logoUpdatedAt" TIMESTAMP(3),
ADD COLUMN "numberLocale" TEXT NOT NULL DEFAULT 'en-US',
ADD COLUMN "dateFormat" VARCHAR(16) NOT NULL DEFAULT 'DD MMM YYYY',
ADD COLUMN "language" VARCHAR(8) NOT NULL DEFAULT 'en',
ADD COLUMN "businessType" VARCHAR(24) NOT NULL DEFAULT 'IMPORT_EXPORT',
ADD COLUMN "industryTemplate" VARCHAR(32) NOT NULL DEFAULT 'GENERAL_TRADING',
ADD COLUMN "transactionCurrencies" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "salesCurrencies" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "defaultSalesCurrency" VARCHAR(3),
ADD COLUMN "features" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "terminology" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "fxCostPolicy" VARCHAR(16) NOT NULL DEFAULT 'RECOST_ALL',
ADD COLUMN "organizationId" TEXT;

-- CreateIndex
CREATE INDEX "companies_organizationId_idx" ON "companies"("organizationId");

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The two existing FID companies become one organization and keep the words
-- and presets they have always had. Guarded, so it is a no-op anywhere else.
DO $$
DECLARE org TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM "companies" WHERE "code" IN ('FID-DXB', 'FID-MA')) THEN
    org := 'org_fid_trading';
    INSERT INTO "organizations" ("id", "name", "plan", "authPolicy", "updatedAt")
    VALUES (org, 'FID Trading', 'ENTERPRISE', 'PIN_AND_PASSWORD', CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING;

    UPDATE "companies"
       SET "organizationId" = org,
           "industryTemplate" = 'COMMODITY_TRADING',
           "tagline" = COALESCE("tagline", 'Coffee Connects Worlds'),
           "terminology" = '{"item":"Coffee"}'::jsonb
     WHERE "code" IN ('FID-DXB', 'FID-MA');

  END IF;
END $$;
