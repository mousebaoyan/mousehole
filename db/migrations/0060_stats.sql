-- Who was active each Beijing day, for the admin's stats (design §10.1): site when they came to the
-- forum, qq when they were active in the groups. Kept 400 days, apart from user_days, where a row
-- is a day visited for levels and check-ins.
CREATE TABLE active_days (
  user_id  integer NOT NULL REFERENCES users (id),
  day      date    NOT NULL,
  site     boolean NOT NULL DEFAULT false,
  qq       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX active_days_day ON active_days (day);

-- A row a day of what can't be counted again later, kept for good. The member counts are the
-- last of the hourly snapshots that day, so days before the first one have none.
CREATE TABLE daily_stats (
  day           date    PRIMARY KEY,
  members       integer,
  activated     integer,
  read_seconds  integer NOT NULL DEFAULT 0,
  posts_read    integer NOT NULL DEFAULT 0
);

-- The days already known: those kept for levels, the floors from the groups and the last time each
-- member spoke there. A kept day with reading, or with nothing from the groups, was a visit;
-- reactions brought over from the groups can't be told apart there and count as visits.
INSERT INTO active_days (user_id, day, site, qq)
SELECT user_id, day, bool_or(site), bool_or(qq)
FROM (
  SELECT d.user_id, d.day, d.posts_read > 0 OR d.read_seconds > 0 OR NOT EXISTS (
      SELECT 1 FROM posts p
      WHERE p.author_id = d.user_id AND p.via <> 'web'
        AND (p.created_at AT TIME ZONE 'Asia/Shanghai')::date = d.day), false
  FROM user_days d
  UNION ALL
  SELECT author_id, (created_at AT TIME ZONE 'Asia/Shanghai')::date, false, true
  FROM posts WHERE via <> 'web'
  UNION ALL
  SELECT user_id, (last_sent_at AT TIME ZONE 'Asia/Shanghai')::date, false, true
  FROM group_members WHERE last_sent_at IS NOT NULL
) known (user_id, day, site, qq)
WHERE day > (now() AT TIME ZONE 'Asia/Shanghai')::date - 400
GROUP BY user_id, day;

INSERT INTO daily_stats (day, read_seconds, posts_read)
SELECT d.day, sum(d.read_seconds), sum(d.posts_read)
FROM user_days d JOIN users u ON u.id = d.user_id
WHERE u.role NOT IN ('bot', 'owner')
GROUP BY d.day;
