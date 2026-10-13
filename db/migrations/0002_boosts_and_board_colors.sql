-- Board colors, and boosts: short notes members leave under a floor.

ALTER TABLE boards
  ADD COLUMN color text NOT NULL DEFAULT '#55625f' CHECK (color ~ '^#[0-9a-f]{6}$'); -- dot in lists and navigation

ALTER TABLE posts ADD COLUMN boost_count integer NOT NULL DEFAULT 0;

CREATE TABLE boosts (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id     integer NOT NULL REFERENCES posts (id), -- floors only, not sub-replies
  user_id     integer NOT NULL REFERENCES users (id),
  body        text    NOT NULL,                       -- at most 16 graphemes, counted by the app
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, user_id)
);

-- A reported boost keeps its floor in post_id.
ALTER TABLE reports
  ADD COLUMN boost_id integer REFERENCES boosts (id) ON DELETE CASCADE,
  DROP CONSTRAINT reports_post_id_reporter_id_key,
  ADD UNIQUE NULLS NOT DISTINCT (post_id, boost_id, reporter_id);
