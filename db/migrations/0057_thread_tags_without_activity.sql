-- Tag pages order the threads by their own last activity; the copy kept with each tag was never
-- read, and rounded to milliseconds it no longer matched. Its index goes with it, so threads are
-- found by tag through one of their own.
ALTER TABLE thread_tags DROP COLUMN last_post_at;
CREATE INDEX thread_tags_tag ON thread_tags (tag_id);
