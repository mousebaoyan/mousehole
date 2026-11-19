-- Our own sites that log people in with the forum, registered by the owner (design §6.7).
CREATE TABLE oauth_clients (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id      text    NOT NULL UNIQUE,
  secret_hash    bytea   NOT NULL,
  name           text    NOT NULL,
  redirect_uris  text[]  NOT NULL,
  scopes         text[]  NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  disabled_at    timestamptz
);

-- Taken out by the token exchange in one DELETE … RETURNING, so a code works once.
CREATE TABLE oauth_codes (
  code_hash       bytea   PRIMARY KEY,
  client_id       integer NOT NULL REFERENCES oauth_clients (id),
  user_id         integer NOT NULL REFERENCES users (id),
  redirect_uri    text    NOT NULL,
  scopes          text[]  NOT NULL,
  code_challenge  text    NOT NULL,
  expires_at      timestamptz NOT NULL
);

-- The app a member's token was issued to; personal tokens have none.
ALTER TABLE api_tokens ADD COLUMN client_id integer REFERENCES oauth_clients (id);
