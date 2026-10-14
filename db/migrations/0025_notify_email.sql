-- Off stops every email reminder at once, whatever each type is set to (design §8.6).
ALTER TABLE users ADD COLUMN notify_email boolean NOT NULL DEFAULT true;
