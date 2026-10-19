-- The pages opened each Beijing day from each address and browser, for the admin's stats and for
-- the owner to see who used an account (design §10.1). Someone signed in has a row of their own,
-- apart from the guest row of the same address and browser. Guests' rows are kept 90 days,
-- members' 400.
CREATE TABLE visits (
  day         date    NOT NULL,
  ip          inet    NOT NULL,
  user_agent  text    NOT NULL,
  user_id     integer REFERENCES users (id),
  views       integer NOT NULL,
  referrer    text,             -- host of the first other site they came from that day
  landing     text    NOT NULL, -- path of the first page they opened that day
  UNIQUE NULLS NOT DISTINCT (day, ip, user_agent, user_id)
);
CREATE INDEX visits_user ON visits (user_id, day DESC);
CREATE INDEX visits_ip ON visits (ip, day DESC);

-- Null on the days before these were recorded.
ALTER TABLE daily_stats
  ADD COLUMN guests        integer,
  ADD COLUMN guest_views   integer,
  ADD COLUMN member_views  integer,
  ADD COLUMN page_bytes    bigint,
  ADD COLUMN api_bytes     bigint,
  ADD COLUMN image_bytes   bigint,
  ADD COLUMN asset_bytes   bigint;
