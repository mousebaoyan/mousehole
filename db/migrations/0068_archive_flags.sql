-- 收录有误 (design §6.5): members flag a floor collected from the group chats that shouldn't have
-- been, one click each, taken back with another; moderators hide the floor or clear the flags.
CREATE TABLE archive_flags (
  post_id    integer     NOT NULL REFERENCES posts (id),
  user_id    integer     NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
