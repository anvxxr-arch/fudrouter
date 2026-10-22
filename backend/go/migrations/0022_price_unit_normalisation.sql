-- Price unit normalisation.
--
-- `model.input_price` / `output_price` are micro-dollars per 1M tokens: the same
-- unit the ledger bills in. The Go cost path proves it -- a ledger row with
-- input_price_micro = 150000.000000 bills 40 tokens as cost 6 micro, i.e.
-- $0.15/1M (see backend/go/internal/proxy/ledger_test.go).
--
-- Nine rows inserted by ops/onboard-excelnt.mjs held dollars per 1M instead,
-- because that script wrote the upstream quote straight into the column. The
-- frontend assumed the dollar reading for every row, so the 153 correctly-stored
-- rows were quoted a million times too expensive -- 238 of 690 cells on /pricing
-- read $1,000+ per 1M tokens and the calculator projected billions a month --
-- while the nine dollar rows happened to display correctly but were billed a
-- million times too cheap. Both sides are fixed: this migration normalises the
-- data to micro, and the frontend now reads micro.
--
-- The threshold is safe because the two populations do not overlap: dollar rows
-- topped out at 16.000000 and micro rows started at 70000.000000.

CREATE TABLE IF NOT EXISTS _fix_price_unit_20261022 AS
SELECT id, slug, name, provider_id, input_price, output_price, now() AS captured_at
FROM model
WHERE (input_price > 0 AND input_price < 1000)
   OR (output_price > 0 AND output_price < 1000);

UPDATE model
SET input_price  = input_price  * 1000000,
    output_price = output_price * 1000000,
    updated_at   = now()
WHERE (input_price > 0 AND input_price < 1000)
   OR (output_price > 0 AND output_price < 1000);
