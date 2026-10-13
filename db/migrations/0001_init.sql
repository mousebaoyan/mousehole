-- Members and accounts

CREATE TABLE users (
  id                integer  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  qq                bigint   UNIQUE,                 -- NULL only after the account is deleted
  display_name      text     NOT NULL,               -- custom_name > card in the primary group > QQ nickname
  custom_name       text,                            -- NULL: follow QQ
  qq_nickname       text     NOT NULL DEFAULT '',
  bio               text     NOT NULL DEFAULT '',
  level             smallint,                        -- group level in the primary group, else the highest in other groups
  role              text     NOT NULL DEFAULT 'user'
                    CHECK (role IN ('user', 'moderator', 'admin', 'bot')),
  role_locked       boolean  NOT NULL DEFAULT false, -- set by an admin; sync leaves it alone
  member_status     text     NOT NULL DEFAULT 'member'
                    CHECK (member_status IN ('member', 'frozen')), -- frozen: in no enabled group
  restriction       text     CHECK (restriction IN ('mute', 'ban')),
  restricted_until  timestamptz,                     -- NULL with a restriction means permanent
  allow_proxy       boolean  NOT NULL DEFAULT true,  -- whether bots may act as this user
  notify_prefs      jsonb    NOT NULL DEFAULT '{}',  -- per notification type: in-site and QQ reminder switches
  avatar_version    integer  NOT NULL DEFAULT 0,     -- part of the avatar URL, bumped on refresh
  thread_count      integer  NOT NULL DEFAULT 0,
  post_count        integer  NOT NULL DEFAULT 0,
  like_received     integer  NOT NULL DEFAULT 0,
  activated_at      timestamptz,                     -- first login; NULL: never logged in
  last_seen_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

CREATE TABLE qq_groups (
  id                bigint   PRIMARY KEY,            -- QQ group number
  name              text     NOT NULL DEFAULT '',
  member_count      integer,
  max_member_count  integer,
  is_primary        boolean  NOT NULL DEFAULT false, -- display names and levels prefer this group
  enabled           boolean  NOT NULL DEFAULT true,  -- disabled groups don't count for membership
  info_synced_at    timestamptz,
  full_synced_at    timestamptz,
  delta_synced_at   timestamptz,
  shrink_held_at    timestamptz,                     -- last full sync held back by the shrink guard
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX qq_groups_primary ON qq_groups (is_primary) WHERE is_primary;

CREATE TABLE group_members (
  group_id      bigint   NOT NULL REFERENCES qq_groups (id),
  user_id       integer  NOT NULL REFERENCES users (id),
  card          text     NOT NULL DEFAULT '',
  role          text     NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  title         text     NOT NULL DEFAULT '',
  level         smallint,
  joined_at     timestamptz,
  last_sent_at  timestamptz,                         -- truncated to the hour to avoid churn
  left_at       timestamptz,                         -- NULL: still in the group
  left_reason   text     CHECK (left_reason IN ('leave', 'kick', 'unknown')),
  observed_at   timestamptz NOT NULL,                -- pushes observed earlier than this are ignored
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user ON group_members (user_id);

-- Login and bots

CREATE TABLE sessions (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash    bytea   NOT NULL UNIQUE,
  user_id       integer NOT NULL REFERENCES users (id),
  user_agent    text    NOT NULL DEFAULT '',
  ip            inet,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(), -- written at most hourly
  expires_at    timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE login_tickets (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text    NOT NULL CHECK (kind IN ('code', 'link')),
  secret_hash  bytea   NOT NULL UNIQUE,  -- code: random value in the browser's cookie; link: token in the URL
  code         text    UNIQUE,           -- 6 digits, code tickets only
  user_id      integer REFERENCES users (id), -- code: set when a bot confirms; link: set when issued
  user_agent   text    NOT NULL DEFAULT '',   -- code: the requesting browser, for the device summary
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL      -- code: 5 minutes; link: 10 minutes
);

CREATE TABLE email_codes (
  user_id     integer  PRIMARY KEY REFERENCES users (id), -- one live code per user; resending overwrites it
  code        text     NOT NULL,            -- plain text: hashing six digits doesn't stop brute force
  attempts    smallint NOT NULL DEFAULT 0,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE TABLE api_tokens (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text    NOT NULL,
  token_hash    bytea   NOT NULL UNIQUE,
  scopes        text[]  NOT NULL,           -- see docs/api.md §2.1
  bot_user_id   integer NOT NULL REFERENCES users (id), -- acts as this user without X-Act-As
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,                -- written at most once a minute
  revoked_at    timestamptz
);

CREATE TABLE idempotency_keys (
  token_id    integer  NOT NULL REFERENCES api_tokens (id),
  key         text     NOT NULL,
  method      text     NOT NULL,
  path        text     NOT NULL,
  status      smallint,                     -- NULL: the first request is still running
  response    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token_id, key)
);

-- Boards and tags

CREATE TABLE boards (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug             text    NOT NULL UNIQUE,
  name             text    NOT NULL,
  description      text    NOT NULL DEFAULT '',
  visibility       text    NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'members')),
  post_role        text    NOT NULL DEFAULT 'user' CHECK (post_role IN ('user', 'moderator')), -- who may start threads
  default_kind     text    NOT NULL DEFAULT 'discussion' CHECK (default_kind IN ('discussion', 'question')),
  review_mode      text    NOT NULL DEFAULT 'after' CHECK (review_mode IN ('after', 'before')), -- review after or before publishing
  allow_anonymous  boolean NOT NULL DEFAULT false,
  position         integer NOT NULL DEFAULT 0,
  thread_count     integer NOT NULL DEFAULT 0,
  post_count       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tags (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text    NOT NULL UNIQUE,
  kind          text    NOT NULL DEFAULT 'topic' CHECK (kind IN ('topic', 'school', 'major')),
  thread_count  integer NOT NULL DEFAULT 0
);

-- Threads and posts

CREATE TABLE threads (
  id              integer  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  board_id        integer  NOT NULL REFERENCES boards (id),
  author_id       integer  NOT NULL REFERENCES users (id),
  kind            text     NOT NULL DEFAULT 'discussion'
                  CHECK (kind IN ('discussion', 'question', 'chatlog')),
  title           text     NOT NULL,
  pinned          smallint NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1, 2)), -- 1: in the board; 2: site-wide
  featured        boolean  NOT NULL DEFAULT false,
  locked          boolean  NOT NULL DEFAULT false,
  anonymous       boolean  NOT NULL DEFAULT false,
  status          text     NOT NULL DEFAULT 'visible'
                  CHECK (status IN ('visible', 'pending', 'hidden')),
  solved_post_id  integer,
  floor_count     integer  NOT NULL DEFAULT 1, -- highest floor number handed out
  reply_count     integer  NOT NULL DEFAULT 0, -- floors, excluding the opening post
  view_count      integer  NOT NULL DEFAULT 0,
  like_count      integer  NOT NULL DEFAULT 0, -- likes on the opening post
  last_poster_id  integer  REFERENCES users (id),
  last_post_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
) WITH (fillfactor = 90); -- room for HOT updates of the counters

CREATE INDEX threads_board ON threads (board_id, pinned DESC, last_post_at DESC, id DESC)
  WHERE deleted_at IS NULL AND status = 'visible';
CREATE INDEX threads_latest ON threads (last_post_at DESC, id DESC)
  WHERE deleted_at IS NULL AND status = 'visible';
CREATE INDEX threads_unsolved ON threads (last_post_at DESC, id DESC)
  WHERE kind = 'question' AND solved_post_id IS NULL AND deleted_at IS NULL AND status = 'visible';
CREATE INDEX threads_author ON threads (author_id, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE thread_tags (
  thread_id     integer NOT NULL REFERENCES threads (id),
  tag_id        integer NOT NULL REFERENCES tags (id),
  last_post_at  timestamptz NOT NULL,        -- copied from the thread so tag pages sort by index
  PRIMARY KEY (thread_id, tag_id)
);
CREATE INDEX thread_tags_list ON thread_tags (tag_id, last_post_at DESC) INCLUDE (thread_id);

CREATE TABLE posts (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thread_id     integer NOT NULL REFERENCES threads (id),
  floor         integer,                       -- NULL for sub-replies
  parent_id     integer REFERENCES posts (id), -- the floor a sub-reply belongs to
  reply_to_id   integer REFERENCES posts (id), -- the post replied to or quoted
  author_id     integer NOT NULL REFERENCES users (id),
  body          text    COMPRESSION lz4 NOT NULL, -- Markdown source
  html          text    COMPRESSION lz4 NOT NULL, -- rendered and sanitized
  anonymous     boolean NOT NULL DEFAULT false,
  status        text    NOT NULL DEFAULT 'visible'
                CHECK (status IN ('visible', 'pending', 'hidden')),
  via           text    NOT NULL DEFAULT 'web'
                CHECK (via IN ('web', 'bot', 'qq')), -- qq: from a group message; bot: posted by a bot
  sub_count     integer NOT NULL DEFAULT 0,
  like_count    integer NOT NULL DEFAULT 0,
  reactions     jsonb   NOT NULL DEFAULT '{}', -- count per emoji, e.g. {"+1": 3}
  edit_count    integer NOT NULL DEFAULT 0,
  edited_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CHECK ((floor IS NULL) <> (parent_id IS NULL))
) WITH (fillfactor = 90);

CREATE UNIQUE INDEX posts_floor ON posts (thread_id, floor) WHERE floor IS NOT NULL;
CREATE INDEX posts_sub ON posts (parent_id, id) WHERE parent_id IS NOT NULL;
CREATE INDEX posts_author ON posts (author_id, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE post_revisions (
  post_id     integer NOT NULL REFERENCES posts (id),
  rev         integer NOT NULL,                 -- starts at 1
  title       text,                             -- old title when the opening post was edited
  body        text    COMPRESSION lz4 NOT NULL, -- Markdown before the edit
  editor_id   integer NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, rev)
);

-- Interactions and notifications

CREATE TABLE reactions (
  post_id     integer NOT NULL REFERENCES posts (id),
  user_id     integer NOT NULL REFERENCES users (id),
  emoji       text    NOT NULL,              -- "+1" is a like; others come from a fixed list
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id, emoji)
);

CREATE TABLE thread_users (
  user_id          integer NOT NULL REFERENCES users (id),
  thread_id        integer NOT NULL REFERENCES threads (id),
  last_read_floor  integer NOT NULL DEFAULT 0,
  notify_level     text    NOT NULL DEFAULT 'normal'
                   CHECK (notify_level IN ('watching', 'normal', 'muted')),
  bookmarked_at    timestamptz,
  PRIMARY KEY (user_id, thread_id)
);
CREATE INDEX thread_users_watchers ON thread_users (thread_id) WHERE notify_level = 'watching';
CREATE INDEX thread_users_bookmarks ON thread_users (user_id, bookmarked_at DESC)
  WHERE bookmarked_at IS NOT NULL;

CREATE TABLE notifications (
  id          bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users (id),
  type        text    NOT NULL,              -- reply, sub_reply, mention, quote, like, solved, watching, moderation, system
  actor_id    integer REFERENCES users (id), -- the latest actor
  thread_id   integer REFERENCES threads (id),
  post_id     integer REFERENCES posts (id),
  group_key   text,                          -- unread notifications with the same key are merged
  count       integer NOT NULL DEFAULT 1,
  data        jsonb   NOT NULL DEFAULT '{}',
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread ON notifications (user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX notifications_merge ON notifications (user_id, group_key)
  WHERE group_key IS NOT NULL AND read_at IS NULL;

-- Images

CREATE TABLE uploads (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sha256      bytea   NOT NULL UNIQUE,       -- of the original file, so the same image is stored once
  user_id     integer NOT NULL REFERENCES users (id), -- the first uploader
  mime        text    NOT NULL,              -- after processing
  width       integer NOT NULL,
  height      integer NOT NULL,
  bytes       integer NOT NULL,              -- both processed sizes together
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE post_uploads (
  post_id    integer NOT NULL REFERENCES posts (id),
  upload_id  integer NOT NULL REFERENCES uploads (id),
  PRIMARY KEY (post_id, upload_id)
);
CREATE INDEX post_uploads_upload ON post_uploads (upload_id);

-- QQ message links and events

CREATE TABLE qq_message_links (
  chat_type   text    NOT NULL CHECK (chat_type IN ('group', 'private')),
  chat_id     bigint  NOT NULL,              -- group number, or the other QQ number in private chats
  message_id  bigint  NOT NULL,
  kind        text    NOT NULL CHECK (kind IN ('source', 'notice')), -- source: content came from it; notice: a bot's post notice
  thread_id   integer NOT NULL REFERENCES threads (id),
  post_id     integer REFERENCES posts (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_type, chat_id, message_id)
);
CREATE INDEX qq_message_links_post ON qq_message_links (post_id) WHERE post_id IS NOT NULL;

CREATE TABLE events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- stream cursor
  txid        xid8   NOT NULL DEFAULT pg_current_xact_id(),    -- readers skip events from uncommitted transactions
  type        text   NOT NULL,
  data        jsonb  NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Moderation

CREATE TABLE reports (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id      integer NOT NULL REFERENCES posts (id),
  reporter_id  integer NOT NULL REFERENCES users (id),
  reason       text    NOT NULL,
  status       text    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  handler_id   integer REFERENCES users (id),
  handled_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, reporter_id)
);
CREATE INDEX reports_open ON reports (created_at) WHERE status = 'open';

CREATE TABLE audit_logs (
  id           bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id     integer REFERENCES users (id),      -- acting as
  operator_id  integer REFERENCES users (id),      -- who asked the bot
  token_id     integer REFERENCES api_tokens (id), -- NULL for web requests
  action       text    NOT NULL,                   -- e.g. thread.create, post.hide, member.freeze
  target_type  text,
  target_id    integer,
  data         jsonb   NOT NULL DEFAULT '{}',      -- key fields before and after, source message, moderation reason
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_target ON audit_logs (target_type, target_id);
CREATE INDEX audit_logs_actor ON audit_logs (actor_id, id DESC);

CREATE TABLE settings (
  key    text  PRIMARY KEY,   -- e.g. site, login, smtp, level_titles, qq_visibility
  value  jsonb NOT NULL       -- secrets are encrypted with APP_SECRET (AES-256-GCM)
);

-- Search

CREATE TABLE post_search (
  post_id   integer  PRIMARY KEY REFERENCES posts (id),
  document  tsvector NOT NULL   -- title (weight A) and body; CJK is split into bigrams, then built with the 'simple' config
);
CREATE INDEX post_search_document ON post_search USING gin (document);
