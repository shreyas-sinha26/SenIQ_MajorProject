-- 0018 API key write permission.
-- Keys were read + run only. A key can now be created with can_write, which lets
-- an agent or script SAVE strategies and START/STOP paper deployments (virtual
-- money only). Default false: every existing key stays read-only, and the write
-- tools are not even listed to a key without it.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS can_write BOOLEAN NOT NULL DEFAULT false;
