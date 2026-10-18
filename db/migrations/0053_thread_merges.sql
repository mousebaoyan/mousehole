-- A thread merged into another (design §8.20): its floors' IDs by their old floor numbers, so a
-- link to one of them finds where that floor is now.
CREATE TABLE thread_merges (
  thread_id   integer PRIMARY KEY REFERENCES threads (id),
  post_ids    integer[] NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
