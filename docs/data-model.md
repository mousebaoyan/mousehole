# 数据表

> 状态：草案。开发时以 `db/migrations/` 里的 SQL 迁移为准，查询用的类型由 kysely-codegen 从数据库生成。下面的表按主题分组，不是建表顺序。

## 约定

- PostgreSQL 18。主键用 `integer` 自增（identity），增长快的表（通知、事件、审计）用 `bigint`；QQ 号、群号、消息 ID 用 `bigint`。
- 时间用 `timestamptz`，接口里统一转成 Unix 秒。布尔用 `boolean`；枚举用 `text` 加 CHECK，比 PostgreSQL 的枚举类型好改；结构化数据用 `jsonb`。
- 软删除用 `deleted_at`，常用索引都是排除已删除行的部分索引。
- 回复数、点赞数等计数冗余存在父行里，和写入在同一个事务里更新，列表页不做聚合。`threads`、`posts` 设 `fillfactor = 90`，计数更新可以走 HOT 更新，不用改索引。
- 列表用游标分页，沿索引顺序取下一页；主题内按楼层号分页，第 N 页直接定位楼层范围，不用 OFFSET。
- 正文列用 lz4 压缩，超过约 2KB 的长文会自动压缩。
- 会话、登录链接、bot token 等令牌只存 SHA-256 哈希。
- 连接：`pg`（node-postgres）连接池最多 10 个连接，另用 1 个单独的连接 LISTEN 事件通知。论坛账号设置 `statement_timeout = '5s'`、`idle_in_transaction_session_timeout = '30s'`。
- 迁移是按编号排列的 SQL 文件，启动时由 Kysely 的 Migrator 依次执行，执行前先取 advisory lock。改完表结构后用 kysely-codegen 重新生成类型，CI 检查生成的类型和迁移是否一致。

## 成员与账号

```sql
CREATE TABLE users (
  id                integer  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  qq                bigint   UNIQUE,                 -- 只在注销后为 NULL
  display_name      text     NOT NULL,               -- 自定义名 > 主群群名片 > QQ 昵称，相关字段变化时重算
  custom_name       text,                            -- 本人设置的显示名；NULL 表示跟随 QQ
  qq_nickname       text     NOT NULL DEFAULT '',
  bio               text     NOT NULL DEFAULT '',
  level             smallint,                        -- 论坛等级：主群的群等级，不在主群时取其他群里最高的
  role              text     NOT NULL DEFAULT 'user'
                    CHECK (role IN ('user', 'moderator', 'admin', 'bot')),
  role_locked       boolean  NOT NULL DEFAULT false, -- true：角色由管理员指定，同步不覆盖
  member_status     text     NOT NULL DEFAULT 'member'
                    CHECK (member_status IN ('member', 'frozen')), -- frozen：不在任何启用的群里
  restriction       text     CHECK (restriction IN ('mute', 'ban')),
  restricted_until  timestamptz,                     -- restriction 不为空、本列为 NULL 表示永久
  allow_proxy       boolean  NOT NULL DEFAULT true,  -- 是否允许 bot 以本人身份操作
  notify_prefs      jsonb    NOT NULL DEFAULT '{}',  -- 各类通知的站内、QQ 提醒开关
  avatar_version    integer  NOT NULL DEFAULT 0,     -- 头像缓存版本，拼在头像地址里
  thread_count      integer  NOT NULL DEFAULT 0,
  post_count        integer  NOT NULL DEFAULT 0,
  like_received     integer  NOT NULL DEFAULT 0,
  activated_at      timestamptz,                     -- 第一次登录的时间；NULL 表示还没登录过
  last_seen_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz                      -- 注销时间
);

CREATE TABLE qq_groups (
  id                bigint   PRIMARY KEY,            -- QQ 群号
  name              text     NOT NULL DEFAULT '',
  member_count      integer,
  max_member_count  integer,
  is_primary        boolean  NOT NULL DEFAULT false, -- 主群：显示名和等级优先取这个群的
  enabled           boolean  NOT NULL DEFAULT true,  -- 停用后不再计入成员资格，例如被封的旧群
  info_synced_at    timestamptz,                     -- 最近一次推送群资料
  full_synced_at    timestamptz,                     -- 最近一次全量同步
  delta_synced_at   timestamptz,                     -- 最近一次增量同步
  shrink_held_at    timestamptz,                     -- 最近一次因名单骤减被拦下的全量
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX qq_groups_primary ON qq_groups (is_primary) WHERE is_primary;

CREATE TABLE group_members (
  group_id      bigint   NOT NULL REFERENCES qq_groups (id),
  user_id       integer  NOT NULL REFERENCES users (id),
  card          text     NOT NULL DEFAULT '',        -- 群名片
  role          text     NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  title         text     NOT NULL DEFAULT '',        -- 专属头衔
  level         smallint,                            -- 群等级
  joined_at     timestamptz,
  last_sent_at  timestamptz,                         -- 最后发言时间，按小时取整
  left_at       timestamptz,                         -- NULL 表示仍在群里
  left_reason   text     CHECK (left_reason IN ('leave', 'kick', 'unknown')),
  observed_at   timestamptz NOT NULL,                -- 这行数据的读取时间，比它旧的推送会被忽略
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user ON group_members (user_id);
```

- **成员资格**：在任意一个启用的群里（`left_at IS NULL`）为 `member`，否则为 `frozen`。这个人的群成员记录变化、或者群的启用状态变化时重算。没有任何群成员记录的账号（只有首次部署命令创建的管理员）保持创建时的状态。
- **角色**：未锁定角色的用户，取所在的启用群里最高的群角色，群主对应 `admin`，群管理员对应 `moderator`；冻结后变回 `user`。机器人（`is_robot`）同步为 `bot`。
- **等级和显示名**：取主群的记录；不在主群时，取其他启用群里等级最高的那条。
- **全量同步**：
  - 名单里的人逐个合并：没带的字段保持原值；只有字段有变化、且推送的读取时间不早于这行的 `observed_at` 时才写入。
  - 名单里没有、仍在群里、`observed_at` 又早于这次全量的成员，标记为退群（`left_reason = 'unknown'`）。
  - 要标记的人数超过当前人数的 20% 时，这次只更新资料、记下 `shrink_held_at`；下一次全量仍然这样，就照常标记。
- **注销**：清空 QQ 号、资料和头像，显示名改为"已注销用户"。之后同步时，会为这个 QQ 号新建一个未激活账号。

## 登录与 bot

```sql
CREATE TABLE sessions (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash    bytea   NOT NULL UNIQUE,
  user_id       integer NOT NULL REFERENCES users (id),
  user_agent    text    NOT NULL DEFAULT '',
  ip            inet,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(), -- 最多每小时更新一次，不必每个请求都写库
  expires_at    timestamptz NOT NULL                -- 90 天，使用时续期
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE login_tickets (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text    NOT NULL CHECK (kind IN ('code', 'link')),
  secret_hash  bytea   NOT NULL UNIQUE,  -- code：浏览器 Cookie 里的随机值；link：链接里的令牌
  code         text    UNIQUE,           -- 6 位数字口令，仅 code
  user_id      integer REFERENCES users (id), -- code：bot 确认后填入；link：签发时填入
  user_agent   text    NOT NULL DEFAULT '',   -- code：发起口令的浏览器，用于生成设备摘要
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL      -- code 5 分钟，link 10 分钟
);

CREATE TABLE email_codes (
  user_id     integer  PRIMARY KEY REFERENCES users (id), -- 每人同时只有一个有效验证码，重发时覆盖
  code        text     NOT NULL,            -- 6 位数字，存原文：位数太少，哈希挡不住穷举
  attempts    smallint NOT NULL DEFAULT 0,  -- 输错 5 次作废
  sent_at     timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL          -- 10 分钟
);

CREATE TABLE api_tokens (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text    NOT NULL,           -- 例如 astrbot
  token_hash    bytea   NOT NULL UNIQUE,
  scopes        text[]  NOT NULL,           -- 见接口文档
  bot_user_id   integer NOT NULL REFERENCES users (id), -- 不带 X-Act-As 时的操作身份，role = 'bot'
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,                -- 最多每分钟更新一次
  revoked_at    timestamptz
);

CREATE TABLE idempotency_keys (
  token_id    integer  NOT NULL REFERENCES api_tokens (id),
  key         text     NOT NULL,
  method      text     NOT NULL,
  path        text     NOT NULL,
  status      smallint,                     -- NULL 表示第一次请求还在处理
  response    jsonb,                        -- 第一次请求的响应体
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token_id, key)
);
```

- 登录票据用完立即删除，过期的每分钟清理。口令票据创建时 `user_id` 为空，bot 确认后填入，浏览器换到会话后删除。
- 幂等：收到带键的请求，先插入一行占位（`status` 为 NULL）再执行；业务写入和回填响应在同一个事务里提交，所以不会出现"已执行但没记下结果"。占位超过 5 分钟仍未完成视为中断，允许重新执行。记录保留 7 天。

## 版块与标签

```sql
CREATE TABLE boards (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug             text    NOT NULL UNIQUE,  -- 地址用，例如 qa
  name             text    NOT NULL,
  description      text    NOT NULL DEFAULT '',
  visibility       text    NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'members')),
  post_role        text    NOT NULL DEFAULT 'user' CHECK (post_role IN ('user', 'moderator')), -- 谁能发主题，公告版为 moderator
  default_kind     text    NOT NULL DEFAULT 'discussion' CHECK (default_kind IN ('discussion', 'question')),
  review_mode      text    NOT NULL DEFAULT 'after' CHECK (review_mode IN ('after', 'before')), -- 先发后审 / 先审后发
  allow_anonymous  boolean NOT NULL DEFAULT false,
  position         integer NOT NULL DEFAULT 0,
  thread_count     integer NOT NULL DEFAULT 0,
  post_count       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tags (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text    NOT NULL UNIQUE,     -- 例如 夏令营、华东师范大学
  kind          text    NOT NULL DEFAULT 'topic' CHECK (kind IN ('topic', 'school', 'major')),
  thread_count  integer NOT NULL DEFAULT 0
);

CREATE TABLE thread_tags (
  thread_id     integer NOT NULL REFERENCES threads (id),
  tag_id        integer NOT NULL REFERENCES tags (id),
  last_post_at  timestamptz NOT NULL,        -- 冗余主题的最后回复时间，标签页直接按索引排序
  PRIMARY KEY (thread_id, tag_id)
);
CREATE INDEX thread_tags_list ON thread_tags (tag_id, last_post_at DESC) INCLUDE (thread_id);
```

主题有新回复时，同时更新 `thread_tags.last_post_at`（每个主题最多 5 个标签）。

## 主题与回复

```sql
CREATE TABLE threads (
  id              integer  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  board_id        integer  NOT NULL REFERENCES boards (id),
  author_id       integer  NOT NULL REFERENCES users (id),
  kind            text     NOT NULL DEFAULT 'discussion'
                  CHECK (kind IN ('discussion', 'question', 'chatlog')),
  title           text     NOT NULL,
  pinned          smallint NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1, 2)), -- 1：版块置顶；2：全站置顶
  featured        boolean  NOT NULL DEFAULT false,
  locked          boolean  NOT NULL DEFAULT false,
  anonymous       boolean  NOT NULL DEFAULT false,
  status          text     NOT NULL DEFAULT 'visible'
                  CHECK (status IN ('visible', 'pending', 'hidden')),
  solved_post_id  integer,                    -- 问答帖被采纳的回复
  floor_count     integer  NOT NULL DEFAULT 1, -- 已分配的最大楼层号
  reply_count     integer  NOT NULL DEFAULT 0, -- 楼层和楼中楼总数，不含主楼
  view_count      integer  NOT NULL DEFAULT 0,
  like_count      integer  NOT NULL DEFAULT 0, -- 主楼的赞
  last_poster_id  integer  REFERENCES users (id),
  last_post_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
) WITH (fillfactor = 90);

CREATE INDEX threads_board ON threads (board_id, pinned DESC, last_post_at DESC, id DESC)
  WHERE deleted_at IS NULL AND status = 'visible';
CREATE INDEX threads_latest ON threads (last_post_at DESC, id DESC)
  WHERE deleted_at IS NULL AND status = 'visible';
CREATE INDEX threads_unsolved ON threads (last_post_at DESC, id DESC)
  WHERE kind = 'question' AND solved_post_id IS NULL AND deleted_at IS NULL AND status = 'visible';
CREATE INDEX threads_author ON threads (author_id, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE posts (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thread_id     integer NOT NULL REFERENCES threads (id),
  floor         integer,                       -- 楼层号；楼中楼为 NULL
  parent_id     integer REFERENCES posts (id), -- 楼中楼所在的楼层；楼层为 NULL
  reply_to_id   integer REFERENCES posts (id), -- 回复或引用的那一条
  author_id     integer NOT NULL REFERENCES users (id),
  body          text    COMPRESSION lz4 NOT NULL, -- Markdown 原文
  html          text    COMPRESSION lz4 NOT NULL, -- 渲染并过滤后的 HTML
  anonymous     boolean NOT NULL DEFAULT false,
  status        text    NOT NULL DEFAULT 'visible'
                CHECK (status IN ('visible', 'pending', 'hidden')),
  via           text    NOT NULL DEFAULT 'web'
                CHECK (via IN ('web', 'bot', 'qq')), -- qq：来自群消息；bot：bot 代发
  sub_count     integer NOT NULL DEFAULT 0,    -- 楼中楼数量，仅楼层
  like_count    integer NOT NULL DEFAULT 0,
  reactions     jsonb   NOT NULL DEFAULT '{}', -- 各表情计数，例如 {"+1": 3, "🎉": 1}
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
  rev         integer NOT NULL,                 -- 从 1 开始
  title       text,                             -- 修改主楼时同时记录旧标题
  body        text    COMPRESSION lz4 NOT NULL, -- 修改前的 Markdown
  editor_id   integer NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, rev)
);
```

- 主楼就是 `floor = 1` 的那条。
- 发楼层：在同一个事务里先 `UPDATE threads SET floor_count = floor_count + 1 ... RETURNING floor_count` 分配楼层号，再插入回复，并更新计数和最后回复。这条 UPDATE 会锁住主题行，同一主题的并发回复因此按顺序拿到楼层号。
- 删除只设 `deleted_at`，楼层号保留，页面显示"该楼已删除"，页码不会错位。
- "最新发布"排序直接按 `id DESC` 走主键，不用单独建索引。

## 互动与通知

```sql
CREATE TABLE reactions (
  post_id     integer NOT NULL REFERENCES posts (id),
  user_id     integer NOT NULL REFERENCES users (id),
  emoji       text    NOT NULL,              -- "+1" 表示赞，其余取自固定的表情列表
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
  type        text    NOT NULL,              -- reply、sub_reply、mention、quote、like、solved、watching、moderation、system
  actor_id    integer REFERENCES users (id), -- 最近一个触发者
  thread_id   integer REFERENCES threads (id),
  post_id     integer REFERENCES posts (id),
  group_key   text,                          -- 可合并的通知（例如同一条回复收到的赞）共用一个键
  count       integer NOT NULL DEFAULT 1,
  data        jsonb   NOT NULL DEFAULT '{}',
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread ON notifications (user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX notifications_merge ON notifications (user_id, group_key)
  WHERE group_key IS NOT NULL AND read_at IS NULL;
```

- 关注级别：`watching` 每个新楼层都通知，`normal` 只在回复我、@我时通知，`muted` 都不通知。发主题时自动设为 `watching`。
- 合并通知：未读期间再次触发同一个 `group_key`，只更新触发者、次数和时间，不新增行。
- 冻结的账号不再产生新通知。已读超过 180 天的通知每天清理。

## 图片

```sql
CREATE TABLE uploads (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sha256      bytea   NOT NULL UNIQUE,       -- 原始文件的哈希，相同图片只处理和存储一次
  user_id     integer NOT NULL REFERENCES users (id), -- 第一次上传的人
  mime        text    NOT NULL,              -- 处理后的格式，通常是 image/webp
  width       integer NOT NULL,
  height      integer NOT NULL,
  bytes       integer NOT NULL,              -- 处理后两档文件合计的大小
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE post_uploads (
  post_id    integer NOT NULL REFERENCES posts (id),
  upload_id  integer NOT NULL REFERENCES uploads (id),
  PRIMARY KEY (post_id, upload_id)
);
CREATE INDEX post_uploads_upload ON post_uploads (upload_id);
```

- 每张图存两个文件：`data/uploads/{哈希前两位}/{哈希}.webp` 是大图（长边不超过 2048px），同目录的 `{哈希}-960.webp` 是正文里显示的一档（宽度不超过 960px）；动图只存大图。地址里带内容哈希，可以永久缓存。
- 上传后 24 小时内没有被任何 `post_uploads` 引用的图片，每天清理。
- 头像统一转成 96px，缓存在 `data/avatars/{用户ID}.webp`，不进数据库，只用 `users.avatar_version` 控制刷新。

## QQ 消息映射与事件

```sql
CREATE TABLE qq_message_links (
  chat_type   text    NOT NULL CHECK (chat_type IN ('group', 'private')),
  chat_id     bigint  NOT NULL,              -- 群号；私聊为对方 QQ 号
  message_id  bigint  NOT NULL,              -- 插件提供的 QQ 消息 ID
  kind        text    NOT NULL CHECK (kind IN ('source', 'notice')), -- source：内容来自这条消息；notice：bot 发出的帖子通知
  thread_id   integer NOT NULL REFERENCES threads (id),
  post_id     integer REFERENCES posts (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_type, chat_id, message_id)
);
CREATE INDEX qq_message_links_post ON qq_message_links (post_id) WHERE post_id IS NOT NULL;

CREATE TABLE events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- 事件流游标
  txid        xid8   NOT NULL DEFAULT pg_current_xact_id(),    -- 写入这条事件的事务
  type        text   NOT NULL,
  data        jsonb  NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

- 事件和触发它的写入在同一个事务里插入：事务提交了事件才存在，不会丢，也不会多。
- 并发事务的提交顺序可能和事件 ID 的顺序不同：如果 ID 小的事务后提交，按 `id > 游标` 读取就会把它漏掉。所以读取时只取已经确定提交完的事务写入的事件：

  ```sql
  SELECT * FROM events
  WHERE id > $cursor AND txid < pg_snapshot_xmin(pg_current_snapshot())
  ORDER BY id LIMIT 100;
  ```

- 事务提交后发 `NOTIFY mousehole_events`，SSE 连接收到通知再读取，不用轮询。
- 事件保留 7 天，每天清理。

## 管理

```sql
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
  actor_id     integer REFERENCES users (id),      -- 以谁的身份
  operator_id  integer REFERENCES users (id),      -- 让 bot 操作的人
  token_id     integer REFERENCES api_tokens (id), -- 经由哪个 bot token；网页操作为 NULL
  action       text    NOT NULL,                   -- 例如 thread.create、post.hide、user.mute、member.freeze
  target_type  text,
  target_id    integer,
  data         jsonb   NOT NULL DEFAULT '{}',      -- 变更前后的关键字段、来源消息、审核理由等
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_target ON audit_logs (target_type, target_id);
CREATE INDEX audit_logs_actor ON audit_logs (actor_id, id DESC);

CREATE TABLE settings (
  key    text  PRIMARY KEY,   -- 例如 site、login、smtp、level_titles、qq_visibility
  value  jsonb NOT NULL       -- 密码类的值用 APP_SECRET 加密（AES-256-GCM）后存储
);
```

- 审计日志记录：经由 bot 的所有写操作、所有管理和审核操作、登录，以及成员角色、冻结和恢复。网页上普通的点赞和回复不记，内容本身就是记录。
- 设置在进程内缓存，后台修改后立即刷新，不用重启。

## 搜索

```sql
CREATE TABLE post_search (
  post_id   integer  PRIMARY KEY REFERENCES posts (id),
  document  tsvector NOT NULL   -- 标题（权重 A）+ 正文；中文先在应用里二元切分，再用 'simple' 配置生成
);
CREATE INDEX post_search_document ON post_search USING gin (document);
```

- 检索数据单独成表，回复表保持紧凑，计数更新也不会牵动检索数据。
- 发布、编辑、删除、隐藏时同步更新；待审核和已隐藏的内容不进索引。
- 查询：应用把查询词切成二元组，每个词组成一个短语（例如"华东师范"变成 `'华东' <-> '东师' <-> '师范'`），多个词之间用 `&` 连接；结果按 `ts_rank_cd` 和时间综合排序，再按可见范围过滤。命中片段从原文生成。

## 二期（占位）

| 表 | 用途 |
| --- | --- |
| `polls`、`poll_votes` | 投票帖 |
| `points_ledger`、`check_ins` | 鼠币流水、签到 |
| `badges`、`user_badges` | 徽章，包括由群荣誉同步来的徽章 |
| `anonymous_aliases` | 匿名编号：同一主题里同一个人的编号固定，例如"匿名鼠鼠 3" |
| `group_notices`、`group_essences`、`group_files` | 同步来的群公告、精华消息、群文件目录 |

## 热点查询与索引

| 查询 | 索引 |
| --- | --- |
| 版块主题列表（置顶在前，按最后回复时间） | `threads_board` |
| 首页"最新" | `threads_latest` |
| 首页"待解答" | `threads_unsolved` |
| 标签页 | `thread_tags_list` |
| 主题第 N 页 | `posts_floor` |
| 某一层的楼中楼 | `posts_sub` |
| 用户的主题和回复 | `threads_author`、`posts_author` |
| 全量同步时取出一个群的成员 | `group_members` 主键 |
| 重算一个人的成员资格 | `group_members_user` |
| 未读通知数 | `notifications_unread` |
| 给关注者发通知 | `thread_users_watchers` |
| 收藏列表 | `thread_users_bookmarks` |
| 由 QQ 消息找论坛内容 | `qq_message_links` 主键 |
| 由回复找来源消息 | `qq_message_links_post` |
| 事件流续传 | `events` 主键 |
| 校验会话 | `sessions.token_hash` 唯一索引 |
| 全文搜索 | `post_search_document` |
