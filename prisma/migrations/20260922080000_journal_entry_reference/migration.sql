-- A journal voucher can carry the client's own reference.
--
-- Every other document has one: an invoice its customer PO, a receipt the
-- cheque or transfer number. A voucher raised by hand — an accrual, an
-- opening balance, a correction — had only its memo, so "which bank advice
-- was that?" could not be answered from the ledger. The reference is
-- optional and free text; nothing existing changes.
ALTER TABLE "journal_entries" ADD COLUMN "reference" VARCHAR(80);
