-- What the bot plugin's LLM made of a busy thread (design §8.18). A moderator turning a thread's
-- summary off leaves the row with disabled set and no summary.
CREATE TABLE thread_summaries (
  thread_id   integer PRIMARY KEY REFERENCES threads (id),
  lead        text,
  points      jsonb,                  -- [{ text, floors }]
  floors      integer[] NOT NULL DEFAULT '{}',
  replies     integer NOT NULL DEFAULT 0,
  disabled    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
