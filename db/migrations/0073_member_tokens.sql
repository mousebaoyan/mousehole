-- Members' own tokens, for their Agents (design §6.7), share the table with bot tokens: a token
-- acts as its user, and the user of a bot token is a bot.
ALTER TABLE api_tokens RENAME COLUMN bot_user_id TO user_id;
CREATE INDEX api_tokens_user ON api_tokens (user_id) WHERE revoked_at IS NULL;

-- What a member's token puts up comes through their Agent.
ALTER TABLE posts DROP CONSTRAINT posts_via_check,
  ADD CONSTRAINT posts_via_check CHECK (via IN ('web', 'bot', 'qq', 'agent'));
ALTER TABLE reactions DROP CONSTRAINT reactions_via_check,
  ADD CONSTRAINT reactions_via_check CHECK (via IN ('web', 'bot', 'qq', 'agent'));
ALTER TABLE boosts DROP CONSTRAINT boosts_via_check,
  ADD CONSTRAINT boosts_via_check CHECK (via IN ('web', 'bot', 'qq', 'agent'));
