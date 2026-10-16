-- More of one's own on their card and page (design §8.16): an accent colour; a status of an emoji
-- and a line, gone by itself after status_until; threads pinned to the page, in order; and a
-- showcase written in Markdown.
ALTER TABLE users
  ADD COLUMN theme text,
  ADD COLUMN status_emoji text,
  ADD COLUMN status_text text,
  ADD COLUMN status_until timestamptz,
  ADD COLUMN pins integer[] NOT NULL DEFAULT '{}',
  ADD COLUMN showcase text,
  ADD CONSTRAINT users_status CHECK ((status_emoji IS NULL) = (status_text IS NULL));
