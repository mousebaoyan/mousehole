-- Anonymous threads, replies and boosts (design §8.12). Who wrote what stays in author_id and
-- user_id; what is shown is "匿名鼠 N", N being the person's number in that thread. The board
-- switch the first schema planned is not how it turned out.
ALTER TABLE boards DROP COLUMN allow_anonymous;
ALTER TABLE threads RENAME COLUMN anonymous TO author_anonymous;
ALTER TABLE threads ADD COLUMN anonymous_replies boolean NOT NULL DEFAULT false;
ALTER TABLE boosts ADD COLUMN anonymous boolean NOT NULL DEFAULT false;

-- Numbers in the order people first wrote anonymously; an anonymous author is 1.
CREATE TABLE thread_aliases (
  thread_id  integer  NOT NULL REFERENCES threads (id),
  user_id    integer  NOT NULL REFERENCES users (id),
  number     integer  NOT NULL,
  PRIMARY KEY (thread_id, user_id),
  UNIQUE (thread_id, number)
);

-- A notification from someone anonymous names them by their number.
ALTER TABLE notifications ADD COLUMN actor_alias integer;

ALTER TABLE drafts
  ADD COLUMN author_anonymous   boolean NOT NULL DEFAULT false,
  ADD COLUMN anonymous_replies  boolean NOT NULL DEFAULT false;
