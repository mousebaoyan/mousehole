-- Anonymous threads and replies no longer add to their author's counts (design §8.12): the count
-- going up right after one appears would tell who wrote it.
UPDATE users SET thread_count = thread_count - anon.threads
FROM (SELECT author_id, count(*) AS threads FROM threads
  WHERE author_anonymous AND status = 'visible' AND deleted_at IS NULL GROUP BY author_id) anon
WHERE users.id = anon.author_id;

UPDATE users SET post_count = post_count - anon.posts
FROM (SELECT author_id, count(*) AS posts FROM posts
  WHERE anonymous AND floor > 1 AND status = 'visible' AND deleted_at IS NULL GROUP BY author_id) anon
WHERE users.id = anon.author_id;
