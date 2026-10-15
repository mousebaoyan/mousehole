-- 分行投票 (design §8.11): rows each rated with the same options, every row its own set of
-- poll_options; and the preset a poll was made from, so far only 保研定位 (design §8.14).
ALTER TABLE polls
  ADD COLUMN rows   text[],                   -- NULL: a plain poll, one row
  ADD COLUMN preset text CHECK (preset IN ('positioning'));

ALTER TABLE poll_options ADD COLUMN row smallint NOT NULL DEFAULT 0;
ALTER TABLE poll_options DROP CONSTRAINT poll_options_thread_id_position_key;
ALTER TABLE poll_options ADD UNIQUE (thread_id, row, position);
