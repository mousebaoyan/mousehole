-- 抽奖帖 (design §8.13): a lottery under the opening post, drawn by the forum at its time.
ALTER TABLE threads DROP CONSTRAINT threads_kind_check;
ALTER TABLE threads ADD CONSTRAINT threads_kind_check
  CHECK (kind IN ('discussion', 'question', 'poll', 'lottery', 'chatlog'));

CREATE TABLE lotteries (
  thread_id     integer     PRIMARY KEY REFERENCES threads (id),
  prizes        jsonb       NOT NULL,          -- [{ name, winners }], drawn in this order
  entry         text        NOT NULL CHECK (entry IN ('button', 'reply')),
  min_level     smallint    NOT NULL DEFAULT 0 CHECK (min_level BETWEEN 0 AND 5),
  draws_at      timestamptz NOT NULL,
  seed          text        NOT NULL,          -- 32 random bytes in hex, kept secret until drawn
  seed_hash     text        NOT NULL,          -- its SHA-256, shown from the start
  drawn_at      timestamptz,
  cancelled_at  timestamptz
);
CREATE INDEX lotteries_due ON lotteries (draws_at) WHERE drawn_at IS NULL AND cancelled_at IS NULL;

-- Who entered. By reply, the rows are only written when it is drawn; ineligible ones are removed
-- then, so after the draw these are exactly who it was drawn from.
CREATE TABLE lottery_entries (
  thread_id   integer     NOT NULL REFERENCES lotteries (thread_id),
  user_id     integer     NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  prize       smallint,                        -- the prize won, by its place in prizes; NULL: none
  PRIMARY KEY (thread_id, user_id)
);

ALTER TABLE drafts DROP CONSTRAINT drafts_kind_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_kind_check
  CHECK (kind IN ('discussion', 'question', 'poll', 'lottery'));
ALTER TABLE drafts ADD COLUMN lottery jsonb;
