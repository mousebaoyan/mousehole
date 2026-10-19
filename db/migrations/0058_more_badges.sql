-- More badges (design §8.8): groups for them, hidden ones, and when each automatic rule caught up on
-- what was there before it. A rule that has not yet does so quietly on its first run; this replaces
-- the one first run of all the rules that job_runs kept.
ALTER TABLE badges
  DROP CONSTRAINT badges_grouping_check,
  ADD CONSTRAINT badges_grouping_check CHECK (grouping IN (
    'start', 'likes', 'answers', 'activity', 'persistence', 'social', 'community', 'coins', 'fun',
    'limited')),
  ADD COLUMN hidden        boolean     NOT NULL DEFAULT false,
  ADD COLUMN caught_up_at  timestamptz;

UPDATE badges
SET caught_up_at = (SELECT ran_at FROM job_runs WHERE name = 'badges')
WHERE slug IS NOT NULL;
DELETE FROM job_runs WHERE name = 'badges';
