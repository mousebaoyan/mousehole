-- 待解答 lists questions only again: polls still taking votes have their own 待投票 (design §8.1).
DROP INDEX threads_unsolved;
CREATE INDEX threads_unsolved ON threads (last_post_at DESC, id DESC)
  WHERE kind = 'question' AND accepted_count = 0 AND deleted_at IS NULL AND status = 'visible';
