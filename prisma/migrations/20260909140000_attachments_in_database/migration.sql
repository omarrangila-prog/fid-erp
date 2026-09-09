-- Attachments move from the filesystem into the database.
--
-- The application runs on a serverless host: the filesystem is read-only and
-- every request gets a fresh container, so a file written during an upload
-- would not survive long enough to be downloaded. Holding the bytes here also
-- puts attachments inside the database backup rather than leaving them as a
-- second thing to remember to copy.
--
-- The table is empty, so no data has to be migrated; `bytes` can be added NOT
-- NULL without a default.

ALTER TABLE "attachments" ADD COLUMN "bytes" BYTEA NOT NULL;
DROP INDEX IF EXISTS "attachments_storageKey_key";
ALTER TABLE "attachments" DROP COLUMN "storageKey";
