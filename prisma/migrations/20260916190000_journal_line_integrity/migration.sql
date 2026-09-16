-- The database refuses a journal line the books could not agree on.
--
-- The cash book reads lines by drawer; the general ledger reads them by
-- account. They can only disagree when a line reaches a drawer's ledger
-- account without naming the drawer, names a drawer on some other account,
-- or carries a currency the drawer cannot hold. The posting engine now
-- prevents all three; this makes the rule hold whatever code writes the
-- row. Lines that move no USD are translation adjustments and are exempt
-- from the currency check.

CREATE OR REPLACE FUNCTION journal_line_integrity() RETURNS trigger AS $$
DECLARE
  head_currency  text;
  drawer_gl      text;
  drawer_ccy     text;
  drawer_name    text;
  translation    boolean;
BEGIN
  translation := (NEW."debitUsd" = 0 AND NEW."creditUsd" = 0);

  IF NEW."cashBankAccountId" IS NOT NULL THEN
    SELECT "glAccountId", "currency", "name"
      INTO drawer_gl, drawer_ccy, drawer_name
      FROM cash_bank_accounts WHERE "id" = NEW."cashBankAccountId";
    IF drawer_gl IS NULL THEN
      RAISE EXCEPTION 'journal line names a cash/bank account that does not exist';
    END IF;
    IF drawer_gl <> NEW."accountId" THEN
      RAISE EXCEPTION 'journal line names % but is posted to another ledger account', drawer_name;
    END IF;
    IF NOT translation AND NEW."currency" <> drawer_ccy THEN
      RAISE EXCEPTION '% is held in %; a % line cannot be recorded through it', drawer_name, drawer_ccy, NEW."currency";
    END IF;
  ELSIF NOT translation THEN
    IF EXISTS (SELECT 1 FROM cash_bank_accounts WHERE "glAccountId" = NEW."accountId") THEN
      RAISE EXCEPTION 'a line on a cash or bank ledger account must name the cash/bank account it moved through';
    END IF;
  END IF;

  IF NOT translation THEN
    SELECT "currency" INTO head_currency FROM accounts WHERE "id" = NEW."accountId";
    IF head_currency IS NOT NULL AND head_currency <> NEW."currency" THEN
      RAISE EXCEPTION 'ledger account is held in %; a % line cannot be posted to it', head_currency, NEW."currency";
    END IF;
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_lines_integrity ON journal_lines;
CREATE TRIGGER journal_lines_integrity
  BEFORE INSERT OR UPDATE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_line_integrity();
