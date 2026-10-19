-- Every mail, sent or dropped, and when reminders and letters were first opened and clicked, for
-- the admin's stats (design §10.1). Kept 400 days.
CREATE TABLE mail_log (
  id          integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  dropped_at  timestamptz,
  opened_at   timestamptz,
  clicked_at  timestamptz
);

-- Mails still waiting have no row and are dropped: the queue empties within seconds.
DELETE FROM mail_queue;
ALTER TABLE mail_queue ADD COLUMN mail_id integer NOT NULL REFERENCES mail_log (id);
