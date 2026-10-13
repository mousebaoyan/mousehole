# 数据表

> 建表语句在 [`db/migrations/`](../db/migrations/)，列的含义写在注释里；查询用的类型由 kysely-codegen 生成到 `db/types.ts`。这里按主题说明各张表的用法。

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
- `bigint` 在应用里读成 JS 的 `number`：QQ 号和各种 ID 都远小于 2^53。

## 成员与账号

表：`users`、`qq_groups`、`group_members`。

- **成员资格**：在任意一个启用的群里（`left_at IS NULL`）为 `member`，否则为 `frozen`。这个人的群成员记录变化、或者群的启用状态变化时重算。没有任何群成员记录的账号（首次部署命令创建的管理员、创建 token 时新建的 bot 账号）保持创建时的状态。重算只写有变化的账号；冻结、恢复和角色变化写入审计日志。
- **同步时间**：`qq_groups` 的 `full_synced_at`、`delta_synced_at`、`info_synced_at` 记的是最近一次生效推送的 `observed_at`（插件读到数据的时间），不是收到的时间。早于 `full_synced_at` 的推送一律忽略：那次全量已经反映了之前的变化，所以没变化的成员行不用每次改写 `observed_at`。同一个群的推送在事务里锁住群这一行，依次处理。
- **角色**：未锁定角色的用户，取所在的启用群里最高的群角色，群主对应 `admin`，群管理员对应 `moderator`；冻结后变回 `user`。机器人（`is_robot`）同步为 `bot`。
- **等级和显示名**：取主群的记录；不在主群时，取其他启用群里等级最高的那条。
- **全量同步**：
  - 名单里的人逐个合并：没带的字段保持原值；只有字段有变化、且推送的读取时间不早于这行的 `observed_at` 时才写入。
  - 名单里没有、仍在群里、`observed_at` 又早于这次全量的成员，标记为退群（`left_reason = 'unknown'`）。
  - 要标记的人数超过当前人数的 20% 时，这次只更新资料、记下 `shrink_held_at`；下一次全量仍然这样，就照常标记。
- **注销**：清空 QQ 号、资料和头像，显示名改为"已注销用户"。之后同步时，会为这个 QQ 号新建一个未激活账号。

## 登录与 bot

表：`sessions`、`login_tickets`、`email_codes`、`api_tokens`、`idempotency_keys`。

- 邮件验证码每人一条，重发就覆盖。每次校验在同一条 `UPDATE` 里累加 `attempts` 并取出验证码，第 5 次之后作废，并发校验也不会多试。
- 登录票据用完立即删除。过期的口令票据在申请新口令时顺手删掉，这样表不会变大，旧口令也能再被抽到；过期的链接票据由定时任务清理。口令票据创建时 `user_id` 为空，bot 确认后填入，浏览器换到会话后删除。
- 每个 bot token 绑定一个 `bot` 角色的账号（`bot_user_id`），创建 token 时按 bot 的 QQ 号找到或新建，角色锁定；登录过的账号不能用作 bot。`last_used_at` 最多一分钟写一次。
- 幂等：收到带键的请求，先插入一行占位（`status` 为 NULL）再执行，执行完回填状态码和响应；5xx 不算结果，删掉占位让重试重新执行。回填在业务事务提交之后，两者之间进程崩溃的话，占位超过 5 分钟视为中断，重试会再执行一次；从群消息创建内容的请求另有 `409 source_exists` 兜底。超过 7 天的键当作新键，旧行由定时任务清理。

## 版块与标签

表：`boards`、`tags`、`thread_tags`。

主题有新回复时，同时更新 `thread_tags.last_post_at`（每个主题最多 5 个标签）。

- `boards.position` 是侧栏里的顺序；移动一个版块时，在同一个事务里给全部版块重新编号。
- `boards.thread_count` 和 `tags.thread_count` 只算公开、没删除的主题。合并标签时把主题挪过去（两个标签都有的只留一行），再重新数一遍目标标签的主题数。
- 删除的主题仍然指向原来的版块，所以有过主题的版块删不掉（外键拦下）。

## 主题与回复

表：`threads`、`posts`、`post_revisions`。

- 所有回复都是楼层，没有楼中楼。`reply_to_id` 记回复的是同一主题里的哪一条，`reply_count` 冗余有几条回复它，和发帖在同一个事务里更新。
- 主楼就是 `floor = 1` 的那条。
- 列表里的参与者：作者加最近 20 层里最近回复的 4 个人。列表查询时按 `posts_floor` 倒着取，每个主题最多读 20 行，不另存。
- 发楼层：在同一个事务里先 `UPDATE threads SET floor_count = floor_count + 1 ... RETURNING floor_count` 分配楼层号，再插入回复，并更新计数和最后回复。这条 UPDATE 会锁住主题行，同一主题的并发回复因此按顺序拿到楼层号。
- 删除只设 `deleted_at`，楼层号保留，页面显示"该楼已删除"，指向某一楼的链接不会错位。
- "最新发布"排序直接按 `id DESC` 走主键，不用单独建索引。
- 计数：`threads.reply_count` 和 `boards.post_count`、`users.post_count` 只算回复（不含主楼），`users.thread_count` 算发过的主题，都和发帖在同一个事务里更新。
- 列表翻页的游标是最后一个主题的 `last_post_at`（微秒，JavaScript 的 Date 只到毫秒）和 ID，"最新发布"是 ID。
- 热门：最近 7 天发布的主题按 `(回复数 × 2 + 赞数 + 浏览数 / 20 + 1) / (发布至今的小时数 + 2)^1.5` 排序，取前 500 个，在内存里存 10 分钟；读列表时再按可见范围和筛选条件过滤。
- 浏览数在内存里累计，每分钟批量写一次；同一个人（登录用户按 ID，访客按 IP）一分钟内只算一次，bot 的请求不算。

## 互动与通知

表：`reactions`、`boosts`、`thread_users`、`notifications`。

- 表情回应每人每条一个，主键 `(post_id, user_id)`，换表情就是覆盖。每个表情都算一次赞：`posts.like_count` 是总数，`posts.reactions` 是各表情的数量，都和写入在同一个事务里更新。
- 短评每人每层一条，`UNIQUE (post_id, user_id)`，修改就是覆盖。字数（16 个字，emoji 算一个）由应用按字素计数，库里不设长度约束。
- 短评数冗余在 `posts.boost_count`，楼层列表每层取前 6 条短评，其余点开再取。删除短评是真删除，它的举报跟着删掉。
- 短评通知的 `type` 是 `boost`，和点赞一样按楼层合并。

- 关注级别：`watching` 每个新楼层都通知，`normal` 只在回复我、@我时通知，`muted` 都不通知。发主题时自动设为 `watching`。
- 合并通知：未读期间再次触发同一个 `group_key`，只更新触发者、次数和时间，不新增行。
- 冻结的账号不再产生新通知。已读超过 180 天的通知每天清理。

- 阅读记录（[总体设计 §8.9](design.md#89-阅读记录)）存在 `thread_users`：`read_floors` 是读过的楼层（`int4multirange`），上报时 `read_floors + 新区间` 并进去，相邻的区间自动合并；`last_read_at` 是最后一次上报的时间。列表里的 `last_read_floor` 取 `upper(read_floors) - 1`。
- 同一个事务里更新 `users` 的阅读统计：`posts_read` 加上这次新读的楼层数（并入前后区间集合的大小之差），`read_seconds` 加上阅读秒数。读过的主题数直接数 `thread_users` 里 `last_read_at` 不为空的行，走 `thread_users_read`。
- `days_visited`：每次更新 `last_seen_at` 时，如果按北京时间已经是新的一天就加一。会话续期和阅读上报都会更新 `last_seen_at`。

## 图片

表：`uploads`、`post_uploads`。

- 每张图存两个文件：`data/uploads/{哈希前两位}/{哈希}.webp` 是大图（长边不超过 2048px），同目录的 `{哈希}-960.webp` 是正文里显示的一档（宽度不超过 960px）；动图只存大图。地址里带内容哈希，可以永久缓存。
- 上传后 24 小时内没有被任何 `post_uploads` 引用的图片，每天清理。
- 头像统一转成 96px，缓存在 `data/avatars/{用户ID}.webp`，不进数据库，只用 `users.avatar_version` 控制刷新。

## QQ 消息映射与事件

表：`qq_message_links`、`events`。

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

表：`reports`、`audit_logs`、`settings`。

- 举报的是短评时填 `boost_id`，`post_id` 填它所在的楼层；同一个人对同一条内容只能举报一次。

- 审计日志记录：经由 bot 的所有写操作、所有管理和审核操作、登录，以及成员角色、冻结和恢复。网页上普通的点赞和回复不记，内容本身就是记录。
- 设置每个分组一行（`login`、`smtp` 等），字段的默认值写在代码里，加字段不用迁移。在进程内缓存，后台修改后立即刷新，不用重启。SMTP 密码用 `APP_SECRET` 做 AES-256-GCM 加密后存入（IV、认证标签和密文拼起来存 base64）。

## 搜索

表：`post_search`。

- 检索数据单独成表，回复表保持紧凑，计数更新也不会牵动检索数据。
- 发布、编辑、删除、隐藏时同步更新；待审核和已隐藏的内容不进索引。
- 查询：应用把查询词切成二元组，每个词组成一个短语（例如"华东师范"变成 `'华东' <-> '东师' <-> '师范'`），多个词之间用 `&` 连接；结果按 `ts_rank_cd` 和时间综合排序，再按可见范围过滤。命中片段从原文生成。

## 二期（占位）

| 表 | 用途 |
| --- | --- |
| `polls`、`poll_votes` | 投票帖 |
| `points_ledger`、`check_ins` | 鼠币流水、签到 |
| `badges`、`user_badges` | 徽章，包括由群荣誉同步来的徽章 |
| `conversations`、`conversation_members`、`messages` | 私信：会话、双方各自的已读位置和屏蔽状态、消息 |
| `anonymous_aliases` | 匿名编号：同一主题里同一个人的编号固定，例如"匿名鼠鼠 3" |
| `group_notices`、`group_essences`、`group_files` | 同步来的群公告、精华消息、群文件目录 |

## 热点查询与索引

| 查询 | 索引 |
| --- | --- |
| 版块主题列表（置顶在前，按最后回复时间） | `threads_board` |
| 首页"最新" | `threads_latest` |
| 首页"待解答" | `threads_unsolved` |
| 标签页 | `thread_tags_list` |
| 主题里某一楼之后或之前的 20 层 | `posts_floor` |
| 回复某一条的楼层 | `posts_reply_to` |
| 列表里每个主题的参与者 | `posts_floor` |
| 用户的主题和回复 | `threads_author`、`posts_author` |
| 全量同步时取出一个群的成员 | `group_members` 主键 |
| 重算一个人的成员资格 | `group_members_user` |
| 未读通知数 | `notifications_unread` |
| 给关注者发通知 | `thread_users_watchers` |
| 收藏列表 | `thread_users_bookmarks` |
| 已读列表、未读列表、读过的主题数 | `thread_users_read` |
| 新主题（最近 7 天发布、没打开过） | 主键倒序取最近 7 天的，再排除 `thread_users` 里读过的 |
| 由 QQ 消息找论坛内容 | `qq_message_links` 主键 |
| 由回复找来源消息 | `qq_message_links_post` |
| 事件流续传 | `events` 主键 |
| 校验会话 | `sessions.token_hash` 唯一索引 |
| 全文搜索 | `post_search_document` |
