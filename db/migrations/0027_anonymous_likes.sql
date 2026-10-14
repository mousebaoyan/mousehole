-- Likes on anonymous floors no longer add to their author's likes (design §8.12): the count
-- going up right after liking one would tell who wrote it.
UPDATE users SET like_received = like_received - anon.likes
FROM (SELECT author_id, sum(like_count) AS likes FROM posts WHERE anonymous GROUP BY author_id) anon
WHERE users.id = anon.author_id;
