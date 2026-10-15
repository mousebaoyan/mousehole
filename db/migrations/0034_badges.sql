-- Badges (design §8.8). The automatic ones are defined in badges/rules.ts and written here on
-- start; those without a slug are event badges, created and given by admins.
CREATE TABLE badges (
  id          integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        text        UNIQUE,
  name        text        NOT NULL UNIQUE,
  description text        NOT NULL,
  tier        text        NOT NULL CHECK (tier IN ('bronze', 'silver', 'gold')),
  grouping    text        NOT NULL CHECK (grouping IN ('start', 'likes', 'answers', 'persistence', 'limited')),
  multiple    boolean     NOT NULL DEFAULT false,
  position    smallint    NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per badge earned; badges earned more than once say for which floor.
CREATE TABLE user_badges (
  id          integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     integer     NOT NULL REFERENCES users (id),
  badge_id    integer     NOT NULL REFERENCES badges (id),
  post_id     integer     REFERENCES posts (id),
  granted_by  integer     REFERENCES users (id),           -- the admin, for badges given by hand
  reason      text,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (user_id, badge_id, post_id)
);
CREATE INDEX user_badges_badge ON user_badges (badge_id, granted_at DESC);

ALTER TABLE users
  ADD COLUMN title_badge_id integer REFERENCES badges (id),
  ADD COLUMN visit_streak   integer NOT NULL DEFAULT 0;

-- When jobs that must not repeat or must know where they left off last ran.
CREATE TABLE job_runs (
  name    text        PRIMARY KEY,
  ran_at  timestamptz NOT NULL
);
