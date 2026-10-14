-- A mail that fails waits longer before each retry and is dropped after a few tries (design §8.6).
ALTER TABLE mail_queue
  ADD COLUMN attempts smallint    NOT NULL DEFAULT 0,
  ADD COLUMN next_at  timestamptz NOT NULL DEFAULT now();
