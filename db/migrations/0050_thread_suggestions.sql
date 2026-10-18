-- L3 suggests a new title, board or tags for a thread; its author or a moderator decides (design
-- §6.6). NULL columns are left as they are.
CREATE TABLE thread_suggestions (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thread_id   integer NOT NULL REFERENCES threads (id),
  user_id     integer NOT NULL REFERENCES users (id),
  title       text,
  board_id    integer REFERENCES boards (id),
  tags        text[],
  reason      text,
  status      text    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected')),
  handler_id  integer REFERENCES users (id),
  handled_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX thread_suggestions_open ON thread_suggestions (thread_id, user_id)
  WHERE status = 'open';
