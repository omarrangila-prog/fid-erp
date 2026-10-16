-- Productization step 3: people and custom roles belong to an organization,
-- so one customer's administrator can never list or edit another's.
-- Additive. Existing users all belong to the single existing customer (FID).

ALTER TABLE "users"
ADD COLUMN "organizationId" TEXT,
ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "roles" ADD COLUMN "organizationId" TEXT;

ALTER TABLE "users" ADD CONSTRAINT "users_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "roles" ADD CONSTRAINT "roles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "users_organizationId_idx" ON "users"("organizationId");
CREATE INDEX "roles_organizationId_idx" ON "roles"("organizationId");

-- Everyone who exists today works for the existing customer.
UPDATE "users" SET "organizationId" = 'org_fid_trading'
WHERE "organizationId" IS NULL AND EXISTS (SELECT 1 FROM "organizations" WHERE "id" = 'org_fid_trading');
