-- Following people, whose new threads then notify the follower, and 认可: vouching for someone's
-- help, once per pair. Counts are counted, not stored: each is one index range.

CREATE TABLE user_follows (
  follower_id  integer NOT NULL REFERENCES users (id),
  followee_id  integer NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX user_follows_followee ON user_follows (followee_id);

CREATE TABLE endorsements (
  user_id      integer NOT NULL REFERENCES users (id), -- the one endorsed
  endorser_id  integer NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, endorser_id),
  CHECK (user_id <> endorser_id)
);
