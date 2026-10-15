-- A question can accept several answers (design §8.1): each floor says whether it is accepted,
-- and the thread counts them for the unsolved list.
ALTER TABLE posts ADD COLUMN accepted boolean NOT NULL DEFAULT false;
ALTER TABLE threads ADD COLUMN accepted_count smallint NOT NULL DEFAULT 0;

UPDATE posts SET accepted = true FROM threads WHERE threads.solved_post_id = posts.id;
UPDATE threads SET accepted_count = 1 WHERE solved_post_id IS NOT NULL;

DROP INDEX threads_unsolved;
ALTER TABLE threads DROP COLUMN solved_post_id;
CREATE INDEX threads_unsolved ON threads (last_post_at DESC, id DESC)
  WHERE kind = 'question' AND accepted_count = 0 AND deleted_at IS NULL AND status = 'visible';
