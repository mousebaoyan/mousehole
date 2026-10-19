-- 待解答 lists polls still taking votes besides unsolved questions (design §8.1); polls can't
-- accept answers, so their accepted_count stays 0.
DROP INDEX threads_unsolved;
CREATE INDEX threads_unsolved ON threads (last_post_at DESC, id DESC)
  WHERE kind IN ('question', 'poll') AND accepted_count = 0 AND deleted_at IS NULL
    AND status = 'visible';
