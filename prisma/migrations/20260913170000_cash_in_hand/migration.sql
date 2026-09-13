-- One cash account per currency, called "Cash in Hand".
--
-- Each company was set up with a cash account and a petty-cash account in the
-- same currency. When someone recorded a cash receipt they were offered both,
-- and the same note could end up in either. The client wants one drawer.
--
-- The local-currency cash account becomes "Cash in Hand" and the USD one
-- "Cash in Hand (USD)". A petty-cash account that has never been used is
-- removed together with its ledger account; one that has postings is kept but
-- retired, because history that names it must keep resolving.

UPDATE cash_bank_accounts cba
   SET "name" = 'Cash in Hand', "updatedAt" = NOW()
  FROM companies c
 WHERE c."id" = cba."companyId"
   AND cba."accountType" = 'CASH'
   AND cba."currency" = c."localCurrency";

UPDATE cash_bank_accounts cba
   SET "name" = 'Cash in Hand (USD)', "updatedAt" = NOW()
  FROM companies c
 WHERE c."id" = cba."companyId"
   AND cba."accountType" = 'CASH'
   AND cba."currency" = 'USD'
   AND c."localCurrency" <> 'USD';

-- Keep the backing ledger account's name in step.
UPDATE accounts a
   SET "name" = CASE
                  WHEN cba."name" LIKE '%(' || cba."currency" || ')' THEN cba."name"
                  ELSE cba."name" || ' (' || cba."currency" || ')'
                END,
       "updatedAt" = NOW()
  FROM cash_bank_accounts cba
 WHERE a."id" = cba."glAccountId"
   AND cba."accountType" = 'CASH';

-- Petty cash with history: retire it.
UPDATE cash_bank_accounts cba
   SET "status" = 'INACTIVE', "updatedAt" = NOW()
 WHERE cba."accountType" = 'PETTY_CASH'
   AND (
        cba."openingBalance" <> 0
     OR EXISTS (SELECT 1 FROM journal_lines jl WHERE jl."cashBankAccountId" = cba."id")
     OR EXISTS (SELECT 1 FROM receipts r WHERE r."cashBankAccountId" = cba."id")
     OR EXISTS (SELECT 1 FROM payments p WHERE p."cashBankAccountId" = cba."id")
     OR EXISTS (SELECT 1 FROM expenses e WHERE e."cashBankAccountId" = cba."id")
     OR EXISTS (SELECT 1 FROM cheques ch WHERE ch."cashBankAccountId" = cba."id")
     OR EXISTS (SELECT 1 FROM bank_reconciliations br WHERE br."cashBankAccountId" = cba."id")
     OR EXISTS (SELECT 1 FROM agent_settlements ags WHERE ags."cashBankAccountId" = cba."id")
   );

-- Petty cash never used: remove it and its ledger account.
CREATE TEMP TABLE unused_petty AS
  SELECT cba."id", cba."glAccountId"
    FROM cash_bank_accounts cba
   WHERE cba."accountType" = 'PETTY_CASH'
     AND cba."status" = 'ACTIVE';

DELETE FROM cash_bank_accounts WHERE "id" IN (SELECT "id" FROM unused_petty);

DELETE FROM accounts a
 WHERE a."id" IN (SELECT "glAccountId" FROM unused_petty)
   AND NOT EXISTS (SELECT 1 FROM journal_lines jl WHERE jl."accountId" = a."id");

DROP TABLE unused_petty;
