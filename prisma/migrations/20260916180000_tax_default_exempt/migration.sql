-- The pre-selected tax code is the exempt one, not the standard rate.
--
-- Every company was set up with its standard-rate code flagged as the default,
-- and the resolver applied the default to any document line that arrived
-- without a code. Purchase orders send none, so a USD supplier balance carried
-- 20% TVA a Ugandan exporter never invoiced; an expense typed as MAD 7,400
-- left cash as 8,880. The resolver no longer falls back at all; this flips the
-- flag so dropdowns start on 0% as well. Data only — no document is touched.

UPDATE tax_codes SET "isDefault" = false, "updatedAt" = NOW()
 WHERE "isDefault" = true AND "code" <> 'EXEMPT';

UPDATE tax_codes SET "isDefault" = true, "updatedAt" = NOW()
 WHERE "code" = 'EXEMPT' AND "isDefault" = false;
