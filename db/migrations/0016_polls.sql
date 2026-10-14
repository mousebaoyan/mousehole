-- 投票帖 (design §8.11): a poll under the opening post.
ALTER TABLE threads DROP CONSTRAINT threads_kind_check;
ALTER TABLE threads ADD CONSTRAINT threads_kind_check
  CHECK (kind IN ('discussion', 'question', 'poll', 'chatlog'));

CREATE TABLE polls (
  thread_id    integer  PRIMARY KEY REFERENCES threads (id),
  multiple     boolean  NOT NULL DEFAULT false,
  max_choices  smallint,                      -- for a multiple choice, at most this many; NULL: any
  anonymous    boolean  NOT NULL DEFAULT false, -- who voted for what isn't shown
  results      text     NOT NULL DEFAULT 'voted' CHECK (results IN ('voted', 'always')),
  closes_at    timestamptz,                   -- NULL: open until closed by hand
  closed_at    timestamptz,                   -- closed early by the author or a moderator
  voter_count  integer  NOT NULL DEFAULT 0
);

CREATE TABLE poll_options (
  id          integer  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thread_id   integer  NOT NULL REFERENCES polls (thread_id),
  position    smallint NOT NULL,
  label       text     NOT NULL,
  vote_count  integer  NOT NULL DEFAULT 0,
  UNIQUE (thread_id, position)
);

CREATE TABLE poll_votes (
  option_id   integer  NOT NULL REFERENCES poll_options (id),
  user_id     integer  NOT NULL REFERENCES users (id),
  thread_id   integer  NOT NULL REFERENCES polls (thread_id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (option_id, user_id)
);
CREATE INDEX poll_votes_voter ON poll_votes (thread_id, user_id);

-- A poll thread being written: its options and settings, as the composer has them.
ALTER TABLE drafts DROP CONSTRAINT drafts_kind_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_kind_check CHECK (kind IN ('discussion', 'question', 'poll'));
ALTER TABLE drafts ADD COLUMN poll jsonb;
