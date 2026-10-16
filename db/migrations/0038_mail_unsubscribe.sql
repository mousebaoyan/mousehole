-- Every mail now has an HTML version; reminders and letters also carry the link that stops them,
-- sent as their List-Unsubscribe header too (design §8.6). Mails still waiting from before have no
-- HTML and are dropped: the queue empties within seconds.
DELETE FROM mail_queue WHERE html IS NULL;
ALTER TABLE mail_queue
  ALTER COLUMN html SET NOT NULL,
  ADD COLUMN unsubscribe text;
