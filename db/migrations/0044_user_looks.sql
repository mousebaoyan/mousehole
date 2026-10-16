-- Moving looks bought with coins (design §8.16): one row each. A background's "custom" is their own
-- picture's, which lets them upload animated ones.
CREATE TABLE user_looks (
  user_id    integer NOT NULL REFERENCES users (id),
  kind       text    NOT NULL CHECK (kind IN ('background', 'frame')),
  key        text    NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, key)
);
