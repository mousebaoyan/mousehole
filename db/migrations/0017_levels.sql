-- The forum's own levels (design §6.6). An admin may fix someone's level, and automatic changes
-- then leave it alone; level_since keeps a fresh L4 from losing it in its first two weeks.
ALTER TABLE users ADD COLUMN level smallint NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 5);
ALTER TABLE users ADD COLUMN level_locked boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN level_since timestamptz;
-- When the latest mute or ban runs out or was lifted; for one with no end, when it began, as it
-- lasts until lifted. Kept once it is over, for L4's "no mute or ban in the last 30 days".
ALTER TABLE users ADD COLUMN restricted_through timestamptz;

-- Each day, in Beijing time, someone visited, read or had content synced from the groups, with
-- what they read that day: L4 looks at the last 30.
CREATE TABLE user_days (
  user_id       integer NOT NULL REFERENCES users (id),
  day           date    NOT NULL,
  posts_read    integer NOT NULL DEFAULT 0,
  read_seconds  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
-- Who was active lately, for the hourly check, and the clearing of old days.
CREATE INDEX user_days_day ON user_days (day);
