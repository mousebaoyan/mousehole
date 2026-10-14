-- What people are still writing, saved as they type so another device can carry on (design
-- §8.2): one new thread per person, and a reply per thread.
CREATE TABLE drafts (
  user_id      integer  NOT NULL REFERENCES users (id),
  thread_id    integer  REFERENCES threads (id),        -- NULL: a new thread
  reply_to_id  integer  REFERENCES posts (id),          -- the floor a reply answers
  title        text     NOT NULL DEFAULT '',
  board_id     integer  REFERENCES boards (id),
  kind         text     CHECK (kind IN ('discussion', 'question')),
  tags         text[]   NOT NULL DEFAULT '{}',          -- tag names
  body         text     NOT NULL DEFAULT '',            -- Markdown
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (user_id, thread_id)
);

-- The daily clearing of drafts nobody touched for 180 days.
CREATE INDEX drafts_updated ON drafts (updated_at);
