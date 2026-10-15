-- Impact and the weekly mail (design §8.15): when an answer was accepted, for the week's counts;
-- how often people's floors were read and by how many; floors read per author per day.
ALTER TABLE posts ADD COLUMN accepted_at timestamptz;
UPDATE posts SET accepted_at = created_at WHERE accepted;
ALTER TABLE posts DROP COLUMN accepted;

ALTER TABLE users
  ADD COLUMN reads_received integer NOT NULL DEFAULT 0,
  ADD COLUMN people_reached integer NOT NULL DEFAULT 0,
  ADD COLUMN weekly_email   boolean NOT NULL DEFAULT true;

-- Others' first reads of someone's floors, per Beijing day; kept 35 days.
CREATE TABLE user_reads (
  user_id  integer NOT NULL REFERENCES users (id),
  day      date    NOT NULL,
  reads    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Who read a thread, for the people someone's floors reached.
CREATE INDEX thread_users_thread ON thread_users (thread_id);

-- The weekly mail is a letter in HTML; the plain text stays for mail apps without it.
ALTER TABLE mail_queue ADD COLUMN html text;
