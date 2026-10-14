# 数据表

> 建表语句在 [`db/migrations/`](../db/migrations/)，列的含义写在注释里；查询用的类型由 kysely-codegen 生成到 `db/types.ts`。这里按领域说明各张表的用法。

## 约定

- PostgreSQL 18。主键用 `integer` 自增（identity），增长快的表（通知、事件、审计）用 `bigint`；QQ 号、群号、消息 ID 用 `bigint`。
- 时间用 `timestamptz`，接口里统一转成 Unix 秒。布尔用 `boolean`；枚举用 `text` 加 CHECK，比 PostgreSQL 的枚举类型好改；结构化数据用 `jsonb`。
- 软删除用 `deleted_at`，常用索引都是排除已删除行的部分索引。
- 回复数、点赞数等计数冗余存在父行里，和写入在同一个事务里更新，列表页不做聚合。`threads`、`posts` 设 `fillfactor = 90`，计数更新可以走 HOT 更新，不用改索引。
- 列表用游标分页，沿索引顺序取下一页；帖子内按楼层号分页，第 N 页直接定位楼层范围，不用 OFFSET。
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
- **显示名**：取主群的群名片；不在主群时，取其他启用群里最早加入的那个，入群时间不知道的排在最后。
- **个性签名**：`custom_bio` 是自己写的，为 `NULL` 时显示 bot 推送的 `qq_bio`。
- **等级**（[总体设计 §6.6](design.md#66-等级)）：`users.level`，`level_locked` 是管理员定下的、不再自动升降，`level_since` 是升到现在这一级的时间，L4 头两周不降级看它。规则是 `levels/rules.ts` 里的纯函数和常量；累计的数直接用 `users` 上的计数（`posts_read`、`read_seconds`、`days_visited`、`like_received`），进入的帖子数和回复过的帖子数现查（`thread_users`、`posts_author`）。最近 30 天的访问和阅读来自 `user_days`：每人每天（北京时间）一行，在会话续期、阅读上报和发帖、回复时写入，当天第一次写入时 `days_visited` 加一；超过 35 天的每天清理。最近 30 天的获赞现查表情回应。禁言封禁看 `restricted_through`：最近一次禁言或封禁到期或解除的时间（没有期限的，在解除前记的是开始的时间），过期后也留着。每小时取 `user_days` 里今天和昨天有记录的人检查升级，走 `user_days_day`。
- **不给访客看**（[总体设计 §8.10](design.md#810-可见范围)）：`users.hide_from_guests`。访客的帖子、楼层、短评和搜索查询都加上"作者没有打开它"的条件（`NOT EXISTS`），走只收打开了的人的部分索引 `users_hidden_from_guests`，不扫 `users` 全表。
- **全量同步**：
  - 名单里的人逐个合并：没带的字段保持原值；只有字段有变化、且推送的读取时间不早于这行的 `observed_at` 时才写入。
  - 名单里没有、仍在群里、`observed_at` 又早于这次全量的成员，标记为退群（`left_reason = 'unknown'`）。
  - 要标记的人数超过当前人数的 20% 时，这次只更新资料、记下 `shrink_held_at`；下一次全量仍然这样，就照常标记。

## 登录与 bot

表：`sessions`、`login_tickets`、`email_codes`、`api_tokens`、`idempotency_keys`。

- 邮件验证码每人一条，重发就覆盖。每次校验在同一条 `UPDATE` 里累加 `attempts` 并取出验证码，第 5 次之后作废，并发校验也不会多试。
- 登录票据用完立即删除。过期的口令票据在申请新口令时顺手删掉，这样表不会变大，旧口令也能再被抽到；过期的链接票据由定时任务清理。口令票据创建时 `user_id` 为空，bot 确认后填入，浏览器换到会话后删除。
- 每个 bot token 绑定一个 `bot` 角色的账号（`bot_user_id`），创建 token 时按 bot 的 QQ 号找到或新建，角色锁定；登录过的账号不能用作 bot。`last_used_at` 最多一分钟写一次。
- 幂等：收到带键的请求，先插入一行占位（`status` 为 NULL）再执行，执行完回填状态码和响应；5xx 不算结果，删掉占位让重试重新执行。回填在业务事务提交之后，两者之间进程崩溃的话，占位超过 5 分钟视为中断，重试会再执行一次；从群消息创建内容的请求另有 `409 source_exists` 兜底。超过 7 天的键当作新键，旧行由定时任务清理。

## 版块与标签

表：`boards`、`tags`、`thread_tags`。

帖子有新回复时，同时更新 `thread_tags.last_post_at`（每个帖子最多 5 个标签）。

- 等级门槛：`boards.read_level` 只用于仅成员的版块（CHECK 约束），`post_level` 是发帖要几级。代码里把"能看到哪些版块"算成一个数 `reach`：访客 -1，只看公开版块；成员是自己的等级，看 `read_level` 不超过它的版块；版主、管理员和 bot 自己的账号是 5，都能看。列表、搜索和单个帖子都按它过滤。
- `boards.position` 是侧栏里的顺序；移动一个版块时，在同一个事务里给全部版块重新编号。
- `boards.thread_count` 和 `tags.thread_count` 只算公开、没删除的帖子。合并标签时把帖子挪过去（两个标签都有的只留一行），再重新数一遍目标标签的帖子数。
- 删除的帖子仍然指向原来的版块，所以有过帖子的版块删不掉（外键拦下）。

## 帖子与楼层

表：`threads`、`posts`、`post_revisions`、`drafts`、`thread_aliases`、`polls`、`poll_options`、`poll_votes`。

- 帖子里的每一层都是 `posts` 的一行，主楼是 `floor = 1` 的那层，没有楼中楼。`reply_to_id` 记回复的是同一帖子里的哪一层，`reply_count` 冗余有几条回复它，和发帖在同一个事务里更新。
- 列表里的参与者：楼主加最近 20 层里最近回复的 4 个人。列表查询时按 `posts_floor` 倒着取，每个帖子最多读 20 行，不另存。
- 发楼层：在同一个事务里先 `UPDATE threads SET floor_count = floor_count + 1 ... RETURNING floor_count` 分配楼层号，再插入回复，并更新计数和最后回复。这条 UPDATE 会锁住帖子行，同一帖子的并发回复因此按顺序拿到楼层号。
- 审核状态：`threads.status`、`posts.status` 取 `visible`（公开）、`pending`（待审核）、`hidden`（已隐藏），主楼跟着帖子。不公开的回复只占一小部分，另有部分索引 `posts_moderated`，后台的内容页和概览从这里读。楼层号在发的时候就分配，待审核和隐藏的楼层也占着号。
- 计数只算公开的内容：内容公开时（直接发布，或者通过、恢复）加进帖子、版块、标签和作者的计数，隐藏时减掉，删除时只减公开的。帖子不公开期间，它里面回复的增减只动帖子和作者的回复数，版块的回复数在帖子公开、隐藏时整体加减。
- 删除只设 `deleted_at`，楼层号保留，页面显示"该楼已删除"，指向某一楼的链接不会错位。删除回复时帖子的回复数、被回复那层的 `reply_count`、版块和作者的回复数都减一；删除帖子时版块、标签和作者的帖子数减一，版块的回复数减去这个帖子的回复数。
- 编辑：`UPDATE posts ... RETURNING edit_count, old.body` 一步拿到新的版本号和旧正文，再插入 `post_revisions`，并发编辑不会撞号。改标题也算主楼的一次编辑，旧标题存在 `post_revisions.title`。
- "最新发布"排序直接按 `id DESC` 走主键，不用单独建索引。热门和"新"从最近 7 天的帖子开始找，走部分索引 `threads_recent`。
- 计数：`threads.reply_count` 和 `boards.post_count`、`users.post_count` 只算公开的回复（不含主楼），`users.thread_count` 算发过的帖子，都和发帖在同一个事务里更新。
- 列表翻页的游标是最后一个帖子的 `last_post_at`（微秒，JavaScript 的 Date 只到毫秒）和 ID，"最新发布"是 ID，收藏列表是 `thread_users.bookmarked_at`（微秒）和 ID。
- 热门：最近 7 天发布的帖子按 `(回复数 × 2 + 赞数 + 浏览数 / 20 + 1) / (发布至今的小时数 + 2)^1.5` 排序，取前 500 个，在内存里存 10 分钟；读列表时再按可见范围和筛选条件过滤。
- 浏览数在内存里累计，每分钟批量写一次；同一个人（登录用户按 ID，访客按 IP）一分钟内只算一次，bot 的请求不算。
- 匿名（[总体设计 §8.12](design.md#812-匿名)）：`threads.author_anonymous`、`threads.anonymous_replies` 是发帖时的两个开关，`posts.anonymous`、`boosts.anonymous` 在写入时按"楼主看前者、别人看后者"定下。`thread_aliases` 记每个人在一个帖子里的编号，第一次匿名写入时分配：锁住帖子那一行，取已有的最大编号加一，楼主匿名时是 1 号。读的时候 left join `thread_aliases`（只在 `anonymous` 为真时连上），有编号的显示成"匿名鼠 N"。通知的 `actor_alias` 是触发的人匿名时的编号。`author_id`、`user_id` 照常记真实的人。
- 草稿（[总体设计 §8.2](design.md#82-正文)）存在 `drafts`，每人每个帖子一行，`thread_id` 为 `NULL` 的是发帖的那份，唯一约束用 `NULLS NOT DISTINCT`，所以发帖的也只有一份。整份覆盖保存；发帖、回复时在同一个事务里删掉对应的草稿（bot 代发的不删）。`updated_at` 超过 180 天的每天清理，走 `drafts_updated`。写了一半的投票整个存在 `drafts.poll`（jsonb），只在发帖时按接口校验。
- 投票（[总体设计 §8.11](design.md#811-投票)）：`threads.kind = 'poll'` 的帖子在 `polls` 里有一行，和帖子在同一个事务里建，`poll_options` 按 `position` 排。`polls.closes_at` 是截止时间，`closed_at` 是提前结束的时间，二者有一个到了就算结束。每人每个选项一行 `poll_votes`，改票是删掉自己的再插入新的；`poll_options.vote_count` 和 `polls.voter_count` 冗余计数，投票时先锁住 `polls` 那一行，同一个投票的票按顺序计。取自己投了什么走 `poll_votes_voter`。

## 互动与通知

表：`reactions`、`boosts`、`thread_users`、`user_follows`、`endorsements`、`notifications`。

- 表情回应每人每条一个，主键 `(post_id, user_id)`，换表情就是覆盖。每个表情都算一次赞：`posts.like_count` 是总数，`posts.reactions` 是各表情的数量，都和写入在同一个事务里更新。
- 短评每人每层一条，`UNIQUE (post_id, user_id)`，修改就是覆盖，排序位置不变。字数（16 个字，emoji 算一个）由应用按字素计数，库里不设长度约束。
- 短评数冗余在 `posts.boost_count`，楼层列表每层取前 6 条短评，其余点开再取。删除短评是真删除，它的举报跟着删掉。

- 关注级别：`watching` 每个新楼层都通知，`normal` 只在回复我、@我时通知，`muted` 都不通知。发帖时自动设为 `watching`。
- 收藏是 `thread_users.bookmarked_at`，重复收藏保留第一次的时间。帖子的查询都 left join 读者自己的那行（访客没有），详情里的收藏和关注级别、收藏列表都从这里来。
- 关注用户（`user_follows`）和认可（`endorsements`）每对人一行，不能对自己。关注数、粉丝数、认可数不冗余存，资料卡里直接数，各是一段索引范围。
- 通知的 `type`：`reply`、`mention`、`like`、`boost`、`watching`、`following`、`solved`，含义见[接口](api.md)的通知对象。都和触发它的写入在同一个事务里插入。
- 一条新楼层只给每人一条通知，按先后取第一个适用的：被回复的那一层的作者（`reply`）、@到的人（`mention`）、关注这个帖子的人（`watching`）。新帖通知 @到的人和作者的粉丝（`following`）。
- 合并通知：`like:{楼层 ID}`、`boost:{楼层 ID}`、`watching:{帖子 ID}` 是 `group_key`，未读期间再次触发只更新触发者、次数、`data` 和时间，不新增行；`post_id` 留着第一次的，点进去从最早没看的那层开始。
- 不通知：自己做的事、冻结的账号、把这个帖子设为 `muted` 的人、在 `users.notify_prefs` 里关掉了这类站内通知的人。`notify_prefs` 形如 `{ "like": { "site": false, "qq": true } }`，站内通知没写的按开着算。
- 已读超过 180 天的通知每天清理。

- 阅读记录（[总体设计 §8.9](design.md#89-阅读记录)）存在 `thread_users`：`read_floors` 是读过的楼层（`int4multirange`），上报时 `read_floors + 新区间` 并进去，相邻的区间自动合并；`last_read_at` 是最后一次上报的时间。列表里的 `last_read_floor` 取 `upper(read_floors) - 1`。
- 发帖和回复时，自己的楼层在同一个事务里并进 `read_floors`，也更新 `last_read_at`，但不计入 `posts_read`。
- 同一个事务里更新 `users` 的阅读统计：`posts_read` 加上这次新读的楼层数（并入前后区间集合的大小之差），`read_seconds` 加上阅读秒数。读过的帖子数直接数 `thread_users` 里 `last_read_at` 不为空的行，走 `thread_users_read`。
- `days_visited`：每次更新 `last_seen_at` 时，如果按北京时间已经是新的一天就加一。会话续期和阅读上报都会更新 `last_seen_at`。

## 图片

表：`uploads`、`post_uploads`。

- 每张图存两个文件：`data/uploads/{哈希前两位}/{哈希}.webp` 是大图（长边不超过 2048px），同目录的 `{哈希}-960.webp` 是正文里显示的一档（宽度不超过 960px）；动图只存大图。地址里带内容哈希，可以永久缓存。
- 动图（`uploads.animated`）保留每一帧，只存大图。`width`、`height` 是大图的尺寸，页面上的尺寸按 960 宽等比算出来，写进渲染好的 HTML。
- 发帖和编辑时，正文里用到的图片记进 `post_uploads`（编辑时先删后加）。
- 上传后 24 小时内没有被任何 `post_uploads` 引用的图片，每天清理，文件一起删掉。
- 头像统一转成 96px，缓存在 `data/avatars/{用户ID}.webp`，不进数据库，只用 `users.avatar_version` 控制刷新：地址是 `/avatars/{用户ID}.webp?v={版本}`，可以永久缓存；版本为 0 表示还没拉到。自己上传的头像也存在这里，`users.avatar_custom` 为真，刷新任务跳过它。
- 刷新任务每小时跑一次，只拉文件已经满 23 小时（或者还没有文件）的，一个接一个地拉，每个头像大约一天拉一次，新成员一小时内就有头像。拉到的图片和现有文件逐字节比较，变了才写入并给 `avatar_version` 加一，没变只更新文件时间；拉取失败的下一小时再试。

## QQ 消息映射与事件

表：`qq_message_links`、`events`。

- `qq_message_links` 以消息为主键：内容来自的消息（`source`）和发帖时在同一个事务里写入，同一条消息只能转一次；bot 发的转存回执（`notice`）可以改指向，但不能覆盖 `source`。群友引用某条消息回复时，按它找到对应的楼层。
- 事件和触发它的写入在同一个事务里插入：事务提交了事件才存在，不会丢，也不会多。
- 并发事务的提交顺序可能和事件 ID 的顺序不同：如果 ID 小的事务后提交，按 `id > 游标` 读取就会把它漏掉。所以读取时只取已经确定提交完的事务写入的事件：

  ```sql
  SELECT * FROM events
  WHERE id > $cursor AND txid < pg_snapshot_xmin(pg_current_snapshot())
  ORDER BY id LIMIT 100;
  ```

- `pg_current_snapshot()` 的 `xmin` 看的是整个 PostgreSQL 实例里还在进行的事务，别的数据库里的也算，所以事件偶尔会被晚一会儿读到。`id > 游标` 还有没发出去的事件时（被挡住了，或者刚变得可读），事件流 200 毫秒后再读一次，不等下一个通知。
- 事务提交后发 `NOTIFY mousehole_events`（在写事件的事务里调用 `pg_notify`，PostgreSQL 在提交时才发出），bot 的事件流连接收到通知再按各自的游标读取，不用轮询；网页上跟着帖子的连接由进程里统一读一次再分发。未读通知数变化时发 `NOTIFY mousehole_notifications`，内容是这些人的 ID（逗号分隔，每次最多 500 个）。两个频道用连接池以外的同一个连接监听，断了一秒后重连，重连后当作都可能变了再读一次。
- 事件保留 7 天，每天清理。

## 管理

表：`reports`、`audit_logs`、`settings`。

- 举报的是短评时填 `boost_id`，`post_id` 填它所在的楼层；同一个人对同一条内容只能举报一次。
- `reports.held`：L4 举报等级比自己低的人的回复时，这一层在同一个事务里改为 `hidden`（[总体设计 §6.6](design.md#66-等级)）；驳回这条举报时，这一层还是 `hidden` 就恢复。

- 审计日志记什么见[总体设计 §13](design.md#13-安全与隐私)。每行有 `actor_id`（以谁的身份）、`operator_id`（谁让 bot 做的）、`token_id`、`ip`、`user_agent`（截到 500 字）、`action`、对象和 `data`；`data` 存看得出改了什么的字段，正文只存开头 100 个字。和改动在同一个事务里写入。按操作人查走 `audit_logs_actor`，按 IP 查走 `audit_logs_ip`。
- 设置每个分组一行（`login`、`smtp` 等），字段的默认值写在代码里，加字段不用迁移。在进程内缓存，后台修改后立即刷新，不用重启。SMTP 密码用 `APP_SECRET` 做 AES-256-GCM 加密后存入（IV、认证标签和密文拼起来存 base64）。

## 搜索

表：`post_search`。

- 检索数据单独成表，回复表保持紧凑，计数更新也不会牵动检索数据。
- 发布、编辑时在同一个事务里写入（`search` 模块的 `indexPost`），删除回复时去掉；改标题时重建主楼那一行。待审核和已隐藏的内容也在索引里，查询时按状态过滤，所以审核和隐藏不用动索引。正文取渲染后 HTML 的纯文本，主楼加上标题（权重 A）。
- 进程启动时把还没进索引的回复补上，所以要按新的切分方式重建，清空表再重启即可。
- 相似问题：把提问原文的所有二元组和单词用 `|` 连起来查，按 `ts_rank_cd(…, 32)`（落在 0 到 1 之间）取每个帖子最高的一层。
- 查询：应用把查询词切成二元组，每个词组成一个短语（例如"华东师范"变成 `'华东' <-> '东师' <-> '师范'`），多个词之间用 `&` 连接；结果按 `ts_rank_cd` 和时间综合排序，再按可见范围过滤。命中片段从原文生成。

## 二期（占位）

| 表 | 用途 |
| --- | --- |
| `points_ledger`、`check_ins` | 鼠币流水、签到 |
| `badges`、`user_badges` | 徽章，包括由群荣誉同步来的徽章 |
| `conversations`、`conversation_members`、`messages` | 私信：会话、双方各自的已读位置和屏蔽状态、消息 |
| `group_notices`、`group_essences`、`group_files` | 同步来的群公告、精华消息、群文件目录 |

## 热点查询与索引

| 查询 | 索引 |
| --- | --- |
| 版块帖子列表（置顶在前，按最后回复时间） | `threads_board` |
| 首页"最新" | `threads_latest` |
| 首页"待解答" | `threads_unsolved` |
| 标签页 | `thread_tags_list` |
| 帖子里某一楼之后或之前的 20 层 | `posts_floor` |
| 回复某一条的楼层 | `posts_reply_to` |
| 列表里每个帖子的参与者 | `posts_floor` |
| 用户的帖子和回复 | `threads_author`、`posts_author` |
| 全量同步时取出一个群的成员 | `group_members` 主键 |
| 重算一个人的成员资格 | `group_members_user` |
| 未读通知数 | `notifications_unread` |
| 给关注者发通知 | `thread_users_watchers` |
| 资料卡的关注数、粉丝数、认可数 | `user_follows` 主键、`user_follows_followee`、`endorsements` 主键 |
| 收藏列表 | `thread_users_bookmarks` |
| 已读列表、未读列表、读过的帖子数 | `thread_users_read` |
| 新帖（最近 7 天发布、没打开过） | 主键倒序取最近 7 天的，再排除 `thread_users` 里读过的 |
| 由 QQ 消息找论坛内容 | `qq_message_links` 主键 |
| 由回复找来源消息 | `qq_message_links_post` |
| 事件流续传 | `events` 主键 |
| 校验会话 | `sessions.token_hash` 唯一索引 |
| 全文搜索 | `post_search_document` |
