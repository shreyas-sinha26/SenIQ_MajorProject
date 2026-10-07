-- 0023 Ask strategy drafts — when the Ask agent turns a plain-English description into a
-- Builder spec (v2), the validated draft is stored with the assistant turn so the thread
-- can offer it again later ("open in Builder"). A draft is NOT a saved strategy: nothing is
-- written to user_strategies, and nothing is backtested or deployed.
--   draft : { spec, rules, data_depth_notes, validated_by, … }  (NULL on every other turn)

ALTER TABLE ask_messages ADD COLUMN IF NOT EXISTS draft JSONB;
