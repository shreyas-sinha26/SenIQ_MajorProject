-- 0047 Sign-up that is confirmed by email, a change of address, and account deletion.
--
-- users.confirm_required: true for an account made by a sign-up that sent a link to its
--   address. Such an account cannot be signed in to until the link is opened
--   (email_verified). False for every account that existed before this migration, and for
--   one made while no email provider was set up: those sign in as they always did.
-- users.pending_email: the address an account has asked to change to. It becomes the
--   account's address when the link sent to it is opened; until then nothing else reads it.
-- auth_tokens.purpose gains 'email_change', the link for that.

ALTER TABLE users ADD COLUMN IF NOT EXISTS confirm_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email TEXT;

ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_purpose_check;
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_purpose_check CHECK (purpose IN ('reset', 'verify', 'email_change'));
