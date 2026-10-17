-- Additive. Customer invoices in the company's own currency show no exchange-rate
-- input or dollar equivalent for FID Trading's companies; every other tenant keeps today's behaviour.
ALTER TABLE "companies" ADD COLUMN "customerFxHidden" BOOLEAN NOT NULL DEFAULT false;

UPDATE "companies" SET "customerFxHidden" = true WHERE "organizationId" = 'org_fid_trading';
