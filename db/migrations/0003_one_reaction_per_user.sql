-- One reaction per person per post: picking another emoji replaces it. The heart is the like,
-- and every reaction counts towards posts.like_count and the reactions counts.

ALTER TABLE reactions
  DROP CONSTRAINT reactions_pkey,
  ADD PRIMARY KEY (post_id, user_id);
