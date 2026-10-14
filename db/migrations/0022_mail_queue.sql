-- Reminder emails (design §8.6): written in the transaction that notifies, sent once it commits.
-- Sent ones are deleted; any still unsent after a day are dropped.
CREATE TABLE mail_queue (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  address     text        NOT NULL,
  subject     text        NOT NULL,
  body        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
