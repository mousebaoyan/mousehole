-- Every reply is a floor in one stream, and points at the post it answers (reply_to_id), as on
-- Discourse. The second level of sub-replies under floors is gone.

ALTER TABLE posts DROP COLUMN parent_id; -- takes posts_sub and the floor/parent check with it
ALTER TABLE posts RENAME COLUMN sub_count TO reply_count; -- how many posts answer this one
ALTER TABLE posts ALTER COLUMN floor SET NOT NULL;

DROP INDEX posts_floor;
CREATE UNIQUE INDEX posts_floor ON posts (thread_id, floor);
CREATE INDEX posts_reply_to ON posts (reply_to_id, id) WHERE reply_to_id IS NOT NULL;
