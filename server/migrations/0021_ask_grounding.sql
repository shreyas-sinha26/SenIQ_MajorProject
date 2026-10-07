-- 0021 Ask grounding check — the result of the post-answer audit (services/answerCheck.js),
-- stored per assistant turn so a "grounded answer rate" can be measured over time.
--   claims_checked     : numbers, dates, URLs and company names found in the answer
--   claims_unsupported : how many of those were not found in the evidence the model had
--   unsupported        : the unsupported ones, [{type, text}], for review
-- NULL on turns that are not model-written (deterministic summaries, scope refusals) and
-- on turns saved before this migration.

ALTER TABLE ask_messages
  ADD COLUMN IF NOT EXISTS claims_checked     INTEGER,
  ADD COLUMN IF NOT EXISTS claims_unsupported INTEGER,
  ADD COLUMN IF NOT EXISTS unsupported        JSONB;
