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

- **成员资格**：在任意一个启用的群里（`left_at IS NULL`）为 `member`，否则为 `frozen`。这个人的群成员记录变化、或者群的启用状态变化时重算。没有任何群成员记录的账号（站长、本地用首次部署命令建的管理员、创建 token 时新建的 bot 账号）保持创建时的状态。重算只写有变化的账号；冻结、恢复和角色变化写入审计日志。
- **同步时间**：`qq_groups` 的 `full_synced_at`、`delta_synced_at`、`info_synced_at` 记的是最近一次生效推送的 `observed_at`（插件读到数据的时间），不是收到的时间。早于 `full_synced_at` 的推送一律忽略：那次全量已经反映了之前的变化，所以没变化的成员行不用每次改写 `observed_at`。同一个群的推送在事务里锁住群这一行，依次处理。
- **角色**：未锁定角色的用户，在任一启用的群里是群主或群管理员的为 `admin`，其余为 `user`，`moderator` 只能手动指定；冻结后变回 `user`。机器人（`is_robot`）同步为 `bot`。
- **站长**（[总体设计 §6.4](design.md#64-角色与权限)）：`role` 为 `owner` 的账号，最多一个（部分唯一索引 `users_owner`），由首次部署命令创建。只有它的 `qq` 为空（`CHECK ((qq IS NULL) = (role = 'owner'))`），所以不收通知和邮件、没有 QQ 头像，也不自动升降级；按 QQ 号或用户 ID 找成员时排除它。
- **显示名**：取主群的群名片；不在主群时，取其他启用群里最早加入的那个，入群时间不知道的排在最后，再一样的取群号小的。专属头衔、资料卡上的群名片、群龄和最近发言也取自这个群。
- **个性签名**：`custom_bio` 是自己写的，为 `NULL` 时显示 bot 推送的 `qq_bio`。
- **等级**（[总体设计 §6.6](design.md#66-等级)）：`users.level`，`level_locked` 是管理员定下的、不再自动升降，`level_since` 是升到现在这一级的时间，L4 头两周不降级看它。规则是 `levels/rules.ts` 里的纯函数和常量；累计的数直接用 `users` 上的计数（`posts_read`、`read_seconds`、`days_visited`、`like_received`），进入的帖子数和回复过的帖子数现查（`thread_users`、`posts_author`）。最近 30 天的访问和阅读来自 `user_days`：每人每天（北京时间）一行，在会话续期、阅读上报和发帖、回复、表情回应、短评时写入（收录的内容写群里发出的那天），这一天第一次写入时 `days_visited` 加一；超过 35 天的每天清理。最近 30 天的获赞现查表情回应。`like_received` 和最近 30 天的获赞都不算匿名楼层得到的赞。禁言封禁看 `restricted_through`：最近一次禁言或封禁到期或解除的时间（没有期限的，在解除前记的是开始的时间），过期后也留着。每小时取 `user_days` 里今天和昨天有记录的人检查升级，走 `user_days_day`。
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

表：`threads`、`posts`、`post_revisions`、`drafts`、`thread_aliases`、`polls`、`poll_options`、`poll_votes`、`lotteries`、`lottery_entries`。

- 帖子里的每一层都是 `posts` 的一行，主楼是 `floor = 1` 的那层，没有楼中楼。`reply_to_id` 记回复的是同一帖子里的哪一层，`reply_count` 冗余有几条回复它，和发帖在同一个事务里更新。
- 列表里的参与者：楼主加最近 20 层里最近回复的 4 个人。列表查询时按 `posts_floor` 倒着取，每个帖子最多读 20 行，不另存。
- 发楼层：在同一个事务里先 `UPDATE threads SET floor_count = floor_count + 1 ... RETURNING floor_count` 分配楼层号，再插入回复，并更新计数和最后回复。这条 UPDATE 会锁住帖子行，同一帖子的并发回复因此按顺序拿到楼层号。
- 审核状态：`threads.status`、`posts.status` 取 `visible`（公开）、`pending`（待审核）、`hidden`（已隐藏），主楼跟着帖子。不公开的回复只占一小部分，另有部分索引 `posts_moderated`，后台的内容页和概览从这里读。楼层号在发的时候就分配，待审核和隐藏的楼层也占着号。
- 计数只算公开的内容：内容公开时（直接发布，或者通过、恢复）加进帖子、版块、标签和作者的计数，隐藏时减掉，删除时只减公开的。帖子不公开期间，它里面回复的增减只动帖子和作者的回复数，版块的回复数在帖子公开、隐藏时整体加减。
- 删除只设 `deleted_at`，楼层号保留，页面显示"该楼已删除"，指向某一楼的链接不会错位。删除回复时帖子的回复数、被回复那层的 `reply_count`、版块和作者的回复数都减一；删除帖子时版块、标签和作者的帖子数减一，版块的回复数减去这个帖子的回复数。
- 编辑：`UPDATE posts ... RETURNING edit_count, old.body` 一步拿到新的版本号和旧正文，再插入 `post_revisions`，并发编辑不会撞号。改标题也算主楼的一次编辑，旧标题存在 `post_revisions.title`。
- 正文：`body` 是 Markdown 原文，`html` 是渲染好的，`render_version` 记 `html` 出自哪一版渲染器（`markdown.ts` 的 `RENDER_VERSION`）。渲染规则一变就把常量加一，启动时把版本更旧的楼层分批重新渲染、重建索引；更新时带上"版本仍然更旧"的条件，期间被编辑过的楼层不会被盖掉。
- "最新发布"排序直接按 `id DESC` 走主键，不用单独建索引。热门和"新"从最近 7 天的帖子开始找，走部分索引 `threads_recent`。
- 采纳（[总体设计 §8.1](design.md#81-版块帖子与楼层)）：`posts.accepted_at` 是被采纳的时间，不为空的就是被采纳的回答（周榜按它数本周被采纳的），一个问答帖可以有几层；`threads.accepted_count` 是其中没删的层数，采纳、取消和删除时在同一个事务里加减，为 0 的问答帖是待解答，走部分索引 `threads_unsolved`。
- 计数：`threads.reply_count` 和 `boards.post_count`、`users.post_count` 只算公开的回复（不含主楼），`users.thread_count` 算发过的帖子；`users` 的两个数不算匿名的内容；都和发帖在同一个事务里更新。
- 列表翻页的游标是最后一个帖子的 `last_post_at`（微秒，JavaScript 的 Date 只到毫秒）和 ID，"最新发布"是 ID，收藏列表是 `thread_users.bookmarked_at`（微秒）和 ID。
- 热门：最近 7 天发布的帖子按 `(回复数 × 2 + 赞数 + 浏览数 / 20 + 1) / (发布至今的小时数 + 2)^1.5` 排序，取前 500 个，在内存里存 10 分钟；读列表时再按可见范围和筛选条件过滤。
- 浏览数在内存里累计，每分钟批量写一次；同一个人（登录用户按 ID，访客按 IP）一分钟内只算一次，bot 的请求不算。
- 匿名（[总体设计 §8.12](design.md#812-匿名)）：`threads.author_anonymous`、`threads.anonymous_replies` 是发帖时的两个开关，`posts.anonymous`、`boosts.anonymous` 在写入时按"楼主看前者、别人看后者"定下。`thread_aliases` 记每个人在一个帖子里的编号，第一次匿名写入时分配：锁住帖子那一行，取已有的最大编号加一，楼主匿名时是 1 号。读的时候 left join `thread_aliases`（只在 `anonymous` 为真时连上），有编号的显示成"匿名鼠 N"。通知的 `actor_alias` 是触发的人匿名时的编号。`author_id`、`user_id` 照常记真实的人。
- 草稿（[总体设计 §8.2](design.md#82-正文)）存在 `drafts`，每人每个帖子一行，`thread_id` 为 `NULL` 的是发帖的那份，唯一约束用 `NULLS NOT DISTINCT`，所以发帖的也只有一份。整份覆盖保存；发帖、回复时在同一个事务里删掉对应的草稿（bot 代发的不删）。`updated_at` 超过 180 天的每天清理，走 `drafts_updated`。写了一半的投票、抽奖和保研定位整个存在 `drafts.poll`、`drafts.lottery`、`drafts.positioning`（jsonb），`kind` 为编辑器里选的类型（保研定位是 `positioning`，发出去是投票帖），只在发帖时按接口校验。
- 投票（[总体设计 §8.11](design.md#811-投票)）：`threads.kind = 'poll'` 的帖子在 `polls` 里有一行，和帖子在同一个事务里建，`poll_options` 按 `position` 排。`polls.closes_at` 是截止时间，`closed_at` 是提前结束的时间，二者有一个到了就算结束。分行投票（总体设计 §8.11）的各行存在 `polls.rows`（`text[]`，普通投票为 `NULL`），每行各有一组 `poll_options`，`row` 是第几行（普通投票都是 0），同一行内按 `position` 排；`polls.preset` 是生成它的预设，目前只有保研定位 `positioning`（总体设计 §8.14），普通投票为 `NULL`。每人每个选项一行 `poll_votes`，改票是删掉自己的再插入新的；`poll_options.vote_count` 和 `polls.voter_count` 冗余计数，投票时先锁住 `polls` 那一行，同一个投票的票按顺序计。取自己投了什么走 `poll_votes_voter`。
- 抽奖（[总体设计 §8.13](design.md#813-抽奖)）：`threads.kind = 'lottery'` 的帖子在 `lotteries` 里有一行，和帖子在同一个事务里建。`prizes` 是按顺序排的奖项（jsonb，`[{ name, winners }]`），发出后不改。`seed` 是建抽奖时生成的 32 个随机字节（十六进制），开奖前不出现在任何接口和日志里；`seed_hash` 是它的 SHA-256，一开始就公布。点按钮参与的每人一行 `lottery_entries`；回复参与的开奖前现查回复（公开、没删、楼层号大于 1、不晚于 `draws_at`），开奖时才写进 `lottery_entries`。每分钟查一次到点的抽奖（走 `lotteries_due`），逐个在事务里锁住那一行开奖：先删掉开奖时不符合条件的参与者，这时 `lottery_entries` 就是参与开奖的全部人，再按 `SHA-256(seed:用户 ID)` 排序，依次给前面的人填上 `prize`（中的是第几个奖项），最后写 `drawn_at`。取消写 `cancelled_at`，之后不再开奖。

## 互动与通知

表：`reactions`、`boosts`、`thread_users`、`user_follows`、`endorsements`、`notifications`、`mail_queue`。

- 表情回应每人每条一个，主键 `(post_id, user_id)`，换表情就是覆盖。每个表情都算一次赞：`posts.like_count` 是总数，`posts.reactions` 是各表情的数量，都和写入在同一个事务里更新。
- 短评每人每层一条，`UNIQUE (post_id, user_id)`，修改就是覆盖，排序位置不变。字数（16 个字，emoji 算一个）由应用按字素计数，库里不设长度约束。
- 短评数冗余在 `posts.boost_count`，楼层列表每层取前 6 条短评，其余点开再取。删除短评是真删除，它的举报跟着删掉。

- 关注级别：`watching` 每个新楼层都通知，`normal` 只在回复我、@我时通知，`muted` 都不通知。发帖时自动设为 `watching`。
- 收藏是 `thread_users.bookmarked_at`，重复收藏保留第一次的时间。帖子的查询都 left join 读者自己的那行（访客没有），详情里的收藏和关注级别、收藏列表都从这里来。
- 关注用户（`user_follows`）和认可（`endorsements`）每对人一行，不能对自己。关注数、粉丝数、认可数不冗余存，资料卡里直接数，各是一段索引范围。
- 个人主页的名单（[总体设计 §9](design.md#9-页面)）：赞过按 `reactions_user`（`user_id, created_at`）倒序取；关系名单分别走 `user_follows` 的主键和 `user_follows_followee`、`endorsements` 的主键和 `endorsements_endorser`，都按 `created_at` 倒序、用偏移翻页。`users.relations_public` 关掉时，别人看不到这几项，这个人也不出现在别人的名单和概要里。概要的两份名单现算：按楼层作者或回应的人分组数表情回应，不算匿名楼层。
- 通知的 `type`：`reply`、`thread_reply`、`mention`、`like`、`boost`、`watching`、`following`、`solved`、`moderation`、`level`、`lottery`、`badge`，含义见[接口](api.md)的通知对象。都和触发它的写入在同一个事务里插入。
- 一条新楼层只给每人一条通知，按先后取第一个适用的：被回复的那一层的作者（`reply`）；@到的人（`mention`）；没指定楼层时是楼主（`thread_reply`）；关注这个帖子的人（`watching`）。新帖通知 @到的人和作者的粉丝（`following`）。从群里收录来的帖子和楼层（`via` 为 `qq`）不产生通知。
- 合并通知：`like:{楼层 ID}`、`boost:{楼层 ID}`、`thread_reply:{帖子 ID}`、`watching:{帖子 ID}` 是 `group_key`，未读期间再次触发只更新触发者、次数、`data` 和时间，不新增行；`post_id` 留着第一次的，点进去从最早没看的那层开始。
- 不通知：自己做的事、冻结的账号、把这个帖子设为 `muted` 的人、在 `users.notify_prefs` 里关掉了这类站内通知的人。`notify_prefs` 形如 `{ "like": { "site": false, "email": true } }`，站内通知没写的按开着算，邮件没写的按站长设的默认值（`settings` 的 `notify`，形如 `{ "email": { "thread_reply": "on", "like": "never" } }`，没写的类型用代码里的默认）；站长设为 `never` 的类型不管怎么写都不发邮件。`users.notify_email` 是邮件提醒的总开关，关掉时哪类都不发邮件，`notify_prefs` 里的设置留着。
- 要发的邮件（`mail_queue`：收件地址、标题、纯文本正文 `body`、HTML 正文 `html`，提醒和每周来信还有退订链接 `unsubscribe`，也作为 `List-Unsubscribe` 邮件头发出）和通知在同一个事务里写入，并 `NOTIFY mousehole_mail`；事务提交后，进程按 `id` 顺序取出到了 `next_at` 的来发，发出去就删掉。发不出去的 `attempts` 加一，`next_at` 往后推（[总体设计 §8.6](design.md#86-通知与实时)），试满 5 次的删掉；每分钟再取一次，放了一天的删掉不发。
- 已读超过 180 天的通知每天清理。

- 阅读记录（[总体设计 §8.9](design.md#89-阅读记录)）存在 `thread_users`：`read_floors` 是读过的楼层（`int4multirange`），上报时 `read_floors + 新区间` 并进去，相邻的区间自动合并；`last_read_at` 是最后一次上报的时间。列表里的 `last_read_floor` 取 `upper(read_floors) - 1`。
- 发帖和回复时，自己的楼层在同一个事务里并进 `read_floors`，也更新 `last_read_at`，但不计入 `posts_read`。
- 同一个事务里更新 `users` 的阅读统计：`posts_read` 加上这次新读的楼层数（并入前后区间集合的大小之差），`read_seconds` 加上阅读秒数。读过的帖子数直接数 `thread_users` 里 `last_read_at` 不为空的行，走 `thread_users_read`。
- `days_visited`：每次更新 `last_seen_at` 时，如果按北京时间已经是新的一天就加一。会话续期和阅读上报都会更新 `last_seen_at`。同时更新连续访问的天数 `visit_streak`，指截至最近一天连着来了几天：新的一天紧接着最近一天就加一，否则从 1 重新算；收录的内容可能补上最近一天之前的某天，这时按 `user_days` 重数截至最近一天的连续天数，比原来多才换上（`user_days` 只留 35 天，算不了 100 天的连续访问）。

## 徽章与影响力

表：`badges`、`user_badges`、`job_runs`、`user_reads`。

- 徽章（[总体设计 §8.8](design.md#88-徽章)）：`badges` 每枚一行，`tier` 取 `bronze`、`silver`、`gold`，`grouping` 是徽章页上的组，`multiple` 表示能得多次。自动授予的徽章和规则都写在代码里（`badges/rules.ts`），进程启动时按 `slug` 写入或更新 `badges`；管理员新建的活动徽章 `slug` 为 `NULL`，只能手动授予，每人一次。
- `user_badges` 每次得到一行：能得多次的记 `post_id`（获赞的那一层、获赞的帖子的主楼、中奖的抽奖帖的主楼），其余为 `NULL`；`UNIQUE NULLS NOT DISTINCT (user_id, badge_id, post_id)`，授予用 `ON CONFLICT DO NOTHING`，当场检查和每小时补查重复了也不会多发。`granted_by` 是手动授予的管理员，自动的为 `NULL`；撤销手动授予的就删掉这一行，记进操作日志。
- 每 5 分钟把每条规则跑一遍：`INSERT INTO user_badges … SELECT` 规则查出的人 `… ON CONFLICT DO NOTHING RETURNING`，先用 `NOT EXISTS` 排除已经有的，每条规则一个事务，新授予的在同一个事务里写通知和 `badge.granted` 事件。`job_runs` 记各个定时任务上次跑的时间；没有 `badges` 这一行时是上线后的第一次检查，补齐以前的内容，不写通知和事件。
- 头衔：`users.title_badge_id`，只能是自己得到的金徽章或银徽章，为 `NULL` 时显示 QQ 的专属头衔。撤销了这枚徽章时一并清空。
- 被读（[总体设计 §8.15](design.md#815-影响力每周邮件和周榜)）：阅读上报时已经算出新读的楼层（并入前后区间集合之差），在同一个事务里按作者分组，不算自己的、匿名的、不公开的楼层，给每个作者的 `users.reads_received` 加上次数，并累加到 `user_reads`（每人每天一行，按北京时间）。`user_reads` 用来算最近 7 天和每周邮件，超过 35 天的每天清理。
- 帮到的人：`users.people_reached` 是读过这个人至少一层的人数，每小时给今天有 `user_reads` 的人重算：按 `thread_users_thread` 取出他发过楼层的帖子的读者，`read_floors @> floor` 的去重计数。
- 每周来信每小时看一次到没到时间（周一 9 点），`job_runs` 的 `weekly_letters` 记这周发过了；`users.weekly_email` 是成员自己的开关。
- 每周来信和周榜现算，每周各一次：赞看 `reactions.created_at`，采纳看 `posts.accepted_at`，新帖新回复看 `created_at`，被读看 `user_reads`，读帖子的人数看 `thread_users.last_read_at` 落在这一周里的行，徽章看 `user_badges.granted_at`。

## 个性化

都是 `users` 上的列（[总体设计 §8.16](design.md#816-个性化)）。预设的背景、头像框、主题色和解锁条件写在代码里（`users/customization.ts`），页面和服务共用，库里只存 key；保存时检查解锁，和原来一样的值不再检查，读的时候也不检查。

- 背景：`background` 是预设的 key，上传的为 `custom`。上传的裁成两张，存在 `data/backgrounds/{用户ID}-card.webp` 和 `{用户ID}-profile.webp`，每次上传覆盖，用 `background_version` 控制缓存，同头像；换成预设或不用背景时删掉这两个文件。
- 头像框：`frame`。活动徽章能配的活动框是 `badges.frame`；撤销手动授予的徽章时，戴着的框如果是徽章解锁的（种子用户、金徽章、活动框），剩下的徽章又解锁不了它，就一并清空；等级解锁的不动。
- 展示徽章：`shown_badge_ids integer[]`，`NULL` 是没选过、按默认规则，`'{}'` 是一枚都不展示；保存时检查是自己得到的，撤销手动授予的徽章时从数组里去掉（`array_remove`，头衔用 `nullif` 一并清掉），读的时候直接按数组取。
- 主题色：`theme`，`NULL` 是默认的海青。
- 状态：`status_emoji`、`status_text`、`status_until`（`NULL` 是不清除），读的时候只取没过期的，不另外清理。
- 代表作：`pins integer[]`，帖子 ID 按显示的顺序；删除、隐藏、匿名的帖子和看的人打不开的，读的时候过滤掉。
- 展柜：`showcase` 是 Markdown 原文，只在个人主页上用，打开时现渲染，不存 HTML，渲染规则变了也不用重新渲染。

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

- `qq_message_links` 以消息为主键，每行是某一层整理自的一条消息；一层可以有几条，一条消息只属于一层。和发帖、回复在同一个事务里写入；更新收录的楼层时，整个换成新的列表。群友引用某条消息回复时，按它找到对应的楼层。
- `position` 是这条消息在这一层里的顺序，按 `source.message_ids` 从 0 数。NapCat 的消息 ID 不按时间递增，所以要单独记顺序；新回答提醒（`GET /bot/answers`）引用的是主楼的第一条（`position = 0`）。
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
- 设置每个分组一行（`login`、`smtp` 等），字段的默认值写在代码里，加字段不用迁移。在进程内缓存，后台修改后立即刷新，不用重启。`smtp` 是发信邮箱的列表，每个邮箱的密码用 `APP_SECRET` 做 AES-256-GCM 加密后存入（IV、认证标签和密文拼起来存 base64）。

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
| 重算帮到的人 | `thread_users_thread` |
| 某枚徽章得到的人、资料卡上的徽章 | `user_badges_badge`（`badge_id, granted_at DESC`）、`user_badges` 的唯一索引 |
| 新帖（最近 7 天发布、没打开过） | 主键倒序取最近 7 天的，再排除 `thread_users` 里读过的 |
| 由 QQ 消息找论坛内容 | `qq_message_links` 主键 |
| 由楼层找来源消息 | `qq_message_links_post` |
| 事件流续传 | `events` 主键 |
| 校验会话 | `sessions.token_hash` 唯一索引 |
| 全文搜索 | `post_search_document` |
