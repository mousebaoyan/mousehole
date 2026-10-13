# 接口

> 状态：草案。开发后以运行时生成的 OpenAPI 为准：`/api/v1/openapi.json`，文档页 `/api/docs`。

## 1. 约定

- **地址**：`https://bbs.mousebaoyan.cn/api/v1`。下文的路径都省略 `/api/v1` 前缀。
- **格式**：请求和响应都是 JSON，字段用 snake_case，时间是 Unix 秒。
- **认证**：网页用 Cookie 会话；bot 用 `Authorization: Bearer <token>`。
- **指代用户**：路径、请求头和请求体里的用户，可以写论坛用户 ID（`123`），也可以写 QQ 号（`qq:123456789`）。
- **QQ 号**：返回给已登录的成员、bot 和管理员；访客看不到（站点设置可以改成公开）。
- **分页**：列表返回 `{ "items": [...], "next_cursor": "..." }`，取下一页时带 `?cursor=`。主题里的楼层用 `?page=`，每页 30 层。
- **错误**：HTTP 状态码加 `{ "error": { "code": "thread_locked", "message": "主题已锁定" } }`。`code` 固定不变，插件据此判断；`message` 给人看，以后可能调整。
- **限流**：按 IP、用户和 token 分别限流，超出时返回 `429` 和 `Retry-After`。
- **CSRF**：网页的写请求校验 Origin；带 Bearer token 的请求不受影响。

### 主要对象（节选）

```jsonc
// 用户。qq、member_status、activated 只返回给成员、bot 和管理员
{ "id": 7, "display_name": "鼠鼠", "avatar_url": "/avatars/7.webp?v=3", "role": "user",
  "qq": 123456789, "card": "26-某某大学-CV", "title": "26届", "level": "活跃",
  "joined_at": 1740000000, "member_status": "member", "activated": true }

// 主题。匿名主题的 author 为 null
{ "id": 42, "board": { "slug": "qa", "name": "保研问答" }, "kind": "question",
  "title": "rank 30% 能冲夏令营吗", "author": { … }, "tags": ["夏令营"],
  "pinned": 0, "featured": false, "locked": false, "status": "visible", "solved_post_id": null,
  "reply_count": 5, "view_count": 120, "like_count": 3,
  "last_post_at": 1760000000, "created_at": 1759990000, "url": "https://bbs.mousebaoyan.cn/t/42" }

// 回复。source 只返回给 bot 和管理员
{ "id": 108, "thread_id": 42, "floor": 3, "parent_id": null, "reply_to_id": null,
  "author": { … }, "body": "Markdown 原文", "html": "<p>…</p>", "via": "qq",
  "source": { "chat_type": "group", "chat_id": 987654321, "message_id": 7731 },
  "status": "visible", "reactions": { "+1": 2 }, "my_reactions": ["+1"], "sub_count": 1,
  "edited_at": null, "created_at": 1760000000 }
```

## 2. bot 认证与代操作

### 2.1 token 与权限范围

token 由管理员在后台创建，只显示一次。一个 token 可以有多个范围：

| 范围 | 允许 |
| --- | --- |
| `read` | 读取全部内容，包括仅成员版块和 QQ 号 |
| `act` | 以群友身份做普通操作：发帖、回复、编辑、删除、点赞、收藏、关注、举报、上传、读通知 |
| `moderate` | 版主操作：审核（通过、隐藏）、置顶、精华、锁定、移动、处理举报、禁言、管理标签 |
| `admin` | 管理员操作：封禁、设置角色、管理版块、站点设置、关联 QQ 群、查看操作日志 |
| `sync` | 推送 QQ 群和成员数据 |
| `auth` | 确认登录口令、签发登录链接 |
| `events` | 订阅事件流 |

### 2.2 请求头

| 请求头 | 说明 |
| --- | --- |
| `X-Act-As: qq:号码` | 以这位成员的身份操作。不带时，以 bot 自己的账号操作 |
| `X-Operator: qq:号码` | 让 bot 执行这次操作的人，写入审计日志 |
| `Idempotency-Key` | 防止重试导致重复执行，见 2.4 |

### 2.3 规则

- **权限取交集**：以 bot 自己的账号操作时，能做什么由 token 的范围决定；代表某位成员时，还要这位成员自己有这个权限。例如代表普通成员时，即使 token 有 `moderate`，也不能锁帖。
- **只能代表成员**：被代表的人必须是已同步、未注销的成员，否则返回 `404 unknown_member`。有人刚进群、论坛还没同步到时，插件先推送进群事件。
- **代发开关**：成员关闭"允许代发"后，只有他本人让 bot 操作（`X-Operator` 就是本人）时才放行，否则写操作返回 `403 proxy_disabled`。读操作不受影响。
- **操作人校验**：带 `X-Operator` 时，论坛会检查操作人有没有资格：代表别人操作时，操作人必须是版主或管理员；以 bot 账号执行管理操作时，操作人自己必须有这个权限。不通过返回 `403 operator_not_allowed`。没有操作人的场景（例如定时任务）可以不带这个头；后台可以设为必须带。
- **来源标注**：代表成员发的内容，带来源消息时 `via` 为 `qq`，页面标"来自群聊"；否则为 `bot`，标"由机器人代发"。本人可以编辑和删除。
- **审计**：经由 bot 的写操作都写入审计日志，记录以谁的身份、操作人、token、来源消息和 IP。

### 2.4 幂等

- 所有 `POST` 请求都可以带 `Idempotency-Key`，最长 128 个字符，建议用 `qq-{群号}-{消息ID}-{动作}`。
- 同一个 token 用同一个键在 7 天内再次请求时，直接返回第一次的结果，不会重复执行。
- 第一次请求还在处理时（例如正在下载图片），重复请求返回 `409 idempotency_in_progress`，稍后重试即可。处理中超过 5 分钟视为中断，可以重新执行。
- 同一个键用在别的接口上，返回 `422 idempotency_key_reused`。
- 另外，如果创建请求带的 `source` 已经对应了论坛内容，返回 `409 source_exists` 并附上已有的对象，避免同一条群消息被转两次。

### 2.5 内容格式

发主题、回复和编辑时，`content` 三选一：

```jsonc
{ "markdown": "正文……" }
{ "onebot": [ { "type": "text", "data": { "text": "……" } } ] }
{ "chat_log": [ { "qq": 123456789, "name": "鼠鼠", "time": 1760000000, "message": [ … ] } ] } // 二期
```

`onebot` 是 OneBot v11 的消息段数组，由论坛负责转换：

| 消息段 | 转换方式 |
| --- | --- |
| `text` | 原样显示，转义 Markdown 符号，保留换行 |
| `image`、`mface` | 论坛立即下载转存（QQ 图片链接会过期）；下载失败时显示"[图片已失效]" |
| `face` | QQ 经典表情；一期显示为"[表情]"，二期换成表情图 |
| `at` | 已同步的成员转为 @论坛用户，并触发提醒；`all` 忽略；其他显示为"@昵称" |
| `reply` | 被回复的消息对应论坛内容时，转为引用；否则忽略 |
| 其他（`file`、`video`、`record`、`json` 等） | 显示为"[文件] 文件名"之类的占位文字 |

`chat_log` 用来发"聊天记录帖"（`kind: "chatlog"`，二期），每条消息的 `message` 同样是 OneBot 消息段。插件把合并转发的节点展开后传进来即可。

`source` 表示内容来自哪条 QQ 消息：

```json
{ "chat_type": "group", "chat_id": 987654321, "message_id": 7731 }
```

## 3. 接口清单

"权限"一栏写的是：网页用户需要的身份 / bot token 需要的范围。

### 3.1 登录与账号

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| POST | `/auth/code` | 申请登录口令，返回 `code`、`expires_at` 和提示文案，同时给这个浏览器设置一个 Cookie | 访客 |
| GET | `/auth/code` | 浏览器轮询口令状态；确认后建立会话，返回当前用户 | 发起口令的浏览器 |
| POST | `/bot/auth/code/confirm` | `{ code }`：以 `X-Act-As` 的身份登录发起口令的浏览器，返回该浏览器的设备摘要 | `auth` |
| POST | `/bot/auth/links` | 给 `X-Act-As` 的成员签发一次性登录链接，10 分钟有效 | `auth` |
| POST | `/auth/link` | `{ token }`：使用登录链接，建立会话 | 访客 |
| POST | `/auth/email` | `{ qq }`：把验证码发到 `QQ号@qq.com`。无论这个 QQ 号是否为成员都返回成功 | 访客 |
| POST | `/auth/email/verify` | `{ qq, code }`：校验验证码，建立会话 | 访客 |
| POST | `/auth/logout` | 退出当前会话 | 成员 |
| GET | `/me` | 当前用户；bot 代表某人时返回这个人 | 成员 / `read` |
| PATCH | `/me` | 修改显示名、简介、是否允许代发、提醒偏好 | 成员 / `act` |
| GET | `/me/sessions` | 已登录的设备 | 成员 |
| DELETE | `/me/sessions/{id}` | 让某个设备下线 | 成员 |
| GET | `/me/export` | 导出自己的全部内容 | 成员 |
| DELETE | `/me` | 注销账号：`{ keep_content }`，`true` 保留内容、署名改为"已注销用户"，`false` 一并删除 | 成员 |

### 3.2 用户

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/users/{user}` | 资料卡：显示名、头像、角色、QQ 号、群名片、群头衔、群等级、入群时间、统计 | 访客 |
| GET | `/users/{user}/threads` | 发过的主题，不含匿名内容 | 访客 |
| GET | `/users/{user}/posts` | 发过的回复，不含匿名内容 | 访客 |
| PATCH | `/users/{user}` | 设置角色、锁定角色 | 管理员 / `admin` |
| PUT | `/users/{user}/restriction` | 禁言或封禁：`{ type, until, reason }`，`type` 为 `mute` 或 `ban` | 禁言：版主 / `moderate`；封禁：管理员 / `admin` |
| DELETE | `/users/{user}/restriction` | 解除禁言或封禁 | 同上 |

### 3.3 版块与标签

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/boards` | 版块列表；访客看不到仅成员版块 | 访客 |
| GET | `/boards/{slug}` | 版块信息 | 访客 |
| POST | `/boards` | 新建版块 | 管理员 / `admin` |
| PATCH | `/boards/{slug}` | 修改版块，包括可见范围和审核方式 | 管理员 / `admin` |
| DELETE | `/boards/{slug}` | 删除空版块 | 管理员 / `admin` |
| GET | `/tags` | 标签列表，可按类别（话题、院校、方向）筛选 | 访客 |
| POST | `/tags` | 新建标签 | 版主 / `moderate` |
| PATCH | `/tags/{id}` | 改名、改类别、合并到另一个标签 | 版主 / `moderate` |
| DELETE | `/tags/{id}` | 删除标签 | 版主 / `moderate` |

### 3.4 主题

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/threads` | 主题列表：`board`、`tag`、`author`、`kind`、`sort`、`cursor`。`sort` 可选 `latest`（最新回复）、`new`（最新发布）、`hot`（热门）、`unsolved`（待解答） | 访客 |
| POST | `/threads` | 发主题：`board`、`title`、`content`、`kind`、`tags`、`source` | 成员 / `act` |
| GET | `/threads/{id}` | 主题详情，含主楼 | 访客 |
| PATCH | `/threads/{id}` | 作者可以改标题和标签；版主还可以改版块、置顶、精华、锁定、`status`（审核通过或隐藏） | 作者、版主 / `act`、`moderate` |
| DELETE | `/threads/{id}` | 删除主题；有人回复后作者不能删，只有版主能删 | 作者、版主 / `act`、`moderate` |
| PUT | `/threads/{id}/solution` | 采纳答案：`{ post_id }` | 主题作者、版主 / `act`、`moderate` |
| DELETE | `/threads/{id}/solution` | 取消采纳 | 同上 |
| PUT | `/threads/{id}/subscription` | 关注级别：`{ level }`，可选 `watching`、`normal`、`muted` | 成员 / `act` |
| PUT | `/threads/{id}/bookmark` | 收藏 | 成员 / `act` |
| DELETE | `/threads/{id}/bookmark` | 取消收藏 | 成员 / `act` |
| PUT | `/threads/{id}/read` | 记录已读到第几楼：`{ floor }` | 成员 |
| GET | `/threads/{id}/stream` | SSE：这个主题的新回复、编辑和删除 | 访客 |

主楼正文用 `PATCH /posts/{主楼 ID}` 修改。

### 3.5 回复

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/threads/{id}/posts` | 楼层列表：`page`（每页 30 层），每层附前 3 条楼中楼 | 访客 |
| POST | `/threads/{id}/posts` | 回复：`content`、`parent_id`（发楼中楼时填楼层 ID）、`reply_to_id`（回复或引用某一条）、`source` | 成员 / `act` |
| GET | `/posts/{id}` | 单条回复，附所在楼层号和页码，方便跳转 | 访客 |
| GET | `/posts/{id}/replies` | 某一层的全部楼中楼：`cursor` | 访客 |
| PATCH | `/posts/{id}` | 作者修改 `content`，保留编辑记录；版主还可以改 `status`（审核通过或隐藏），可附 `reason` | 作者、版主 / `act`、`moderate` |
| DELETE | `/posts/{id}` | 删除；楼层号保留，显示"该楼已删除" | 作者、版主 / `act`、`moderate` |
| GET | `/posts/{id}/revisions` | 编辑记录 | 作者、版主 / `read` |
| PUT | `/posts/{id}/reactions/{emoji}` | 点赞（`+1`）或表情回应 | 成员 / `act` |
| DELETE | `/posts/{id}/reactions/{emoji}` | 取消 | 成员 / `act` |
| GET | `/posts/{id}/reactions` | 谁回应了什么 | 访客 |
| POST | `/posts/{id}/report` | 举报：`{ reason }` | 成员 / `act` |

### 3.6 搜索

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/search` | `q`、`board`、`tag`、`author`、`kind`、`cursor`；返回主题和高亮片段 | 访客 |
| GET | `/search/similar` | `text`：一段提问原文；返回最相似的 5 个主题和得分 | 访客 |

### 3.7 上传

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| POST | `/uploads` | 用 multipart 上传图片，返回 `id`、`url`、`width`、`height` | 成员 / `act` |
| POST | `/uploads/fetch` | `{ url }`：论坛下载并转存，只接受 QQ 的图片域名 | `act` |

一般不需要单独调用 `/uploads/fetch`：`content.onebot` 里的图片会自动转存。

### 3.8 通知

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/notifications` | 通知列表：`unread_only`、`cursor` | 成员 / `act` |
| GET | `/notifications/unread-count` | 未读数 | 成员 / `act` |
| POST | `/notifications/read` | 标为已读：`{ ids }` 或 `{ all: true }` | 成员 / `act` |
| GET | `/stream` | SSE：当前用户的新通知和未读数 | 成员 |

### 3.9 管理

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/admin/pending` | 待审核的主题和回复 | 版主 / `moderate` |
| GET | `/admin/reports` | 举报列表：`status` | 版主 / `moderate` |
| PATCH | `/admin/reports/{id}` | 处理举报：`{ status }`，可选 `resolved`、`dismissed` | 版主 / `moderate` |
| GET | `/admin/audit-logs` | 操作日志，可以按操作人、对象、动作筛选 | 管理员 / `admin` |
| GET | `/admin/settings` | 站点设置 | 管理员 / `admin` |
| PATCH | `/admin/settings` | 修改站点设置 | 管理员 / `admin` |
| GET、POST、DELETE | `/admin/tokens` | 管理 bot token | 管理员，只能在网页上操作 |

审核通过或隐藏内容，用 `PATCH /threads/{id}` 或 `PATCH /posts/{id}` 修改 `status`。

### 3.10 bot 专用

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/bot/groups` | 已关联的 QQ 群 | `sync` |
| PUT | `/bot/groups/{group_id}` | 关联或修改群：`name`、`is_primary`、`enabled` | `admin` |
| PUT | `/bot/groups/{group_id}/members` | 完整成员名单：`[{ qq, nickname, card, role, title, level, join_time }]`；名单里没有的人记为已退群 | `sync` |
| POST | `/bot/groups/{group_id}/member-events` | 成员变动：`{ type, qq, card?, time }`，`type` 为 `join`、`leave`、`kick`、`card`、`admin`、`unadmin` | `sync` |
| GET | `/bot/messages/{chat_type}/{chat_id}/{message_id}` | 某条 QQ 消息对应的论坛主题或回复 | `read` |
| PUT | `/bot/messages/{chat_type}/{chat_id}/{message_id}` | 记录 bot 发出的帖子通知：`{ thread_id, post_id? }` | `act` |
| GET | `/bot/events` | SSE 事件流，见第 4 节 | `events` |
| GET | `/bot/events/batch` | 按游标拉取事件：`after`、`limit`，返回 JSON | `events` |

## 4. 事件流

```text
GET /api/v1/bot/events
Authorization: Bearer <token>
Last-Event-ID: 1023

id: 1024
event: post.created
data: {"post":{…},"thread":{…},"author":{…},"qq_text":"……","url":"https://bbs.mousebaoyan.cn/t/42?floor=3"}
```

- 带 `Last-Event-ID`（或 `?after=`）时，先补发之后的事件，再实时推送；都不带时只推新事件。
- 每 20 秒发一条心跳注释，防止代理断开连接。
- 事件保留 7 天。游标早于最早的事件时返回 `410 cursor_expired`，并附上当前最新的事件 ID，插件可以从那里重新开始。
- 至少投递一次：网络中断可能导致重复投递，插件按事件 ID 去重，处理完再保存游标。
- 用 `?types=thread.created,notification.created` 只订阅部分类型。

| 类型 | 触发时机 | 主要字段 |
| --- | --- | --- |
| `thread.created` | 新主题公开（先审后发的版块在审核通过时） | `thread`、`board`、`author`、`source`、`url`、`qq_text` |
| `post.created` | 新回复公开 | `post`、`thread`、`author`、`reply_to`（被回复的那条、它的作者和来源消息）、`source`、`url`、`qq_text` |
| `post.updated` | 回复或主楼被编辑 | `post`、`thread`、`editor` |
| `post.deleted` | 回复或主题被删除、隐藏 | `post_id`、`thread_id`、`by`、`reason` |
| `thread.solved` | 采纳答案 | `thread`、`post`、`answerer` |
| `content.pending` | 先审后发的版块有新内容等待审核 | `thread`、`post`、`author` |
| `notification.created` | 给某位成员产生通知，且他开启了这类通知的 QQ 提醒 | `user`、`type`、`actor`、`thread`、`post`、`url`、`qq_text` |
| `member.activated` | 成员第一次登录 | `user` |
| `report.created` | 有新举报 | `report`、`post`、`reporter` |

- `qq_text` 是可以直接发到 QQ 的纯文本，例如"【保研问答】rank 30% 能冲夏令营吗\n鼠鼠：……\nhttps://bbs.mousebaoyan.cn/t/42"。
- 事件里的用户对象都带 `qq`，插件可以直接 @ 或私聊。匿名内容（二期）的事件不带作者。
- 审核可以挂在事件上：先发后审的版块监听 `thread.created`、`post.created`，先审后发的版块监听 `content.pending`，判定后调用 `PATCH` 修改 `status`。

## 5. 流程

### 5.1 口令登录

```mermaid
sequenceDiagram
    participant B as 浏览器
    participant F as 论坛
    participant P as 插件
    actor U as 群友
    B->>F: POST /auth/code
    F-->>B: 口令 482913，5 分钟有效，并设置本浏览器专用的 Cookie
    U->>P: 把口令发给 bot
    P->>F: POST /bot/auth/code/confirm，X-Act-As 为发送者
    F-->>P: 设备摘要，例如 Chrome · macOS
    P-->>U: 告诉他哪台设备登录了
    loop 每 2 秒
        B->>F: GET /auth/code
    end
    F-->>B: 已确认，建立会话
```

- 口令只能确认一次，确认接口按 QQ 号限流。
- 设备摘要用来防骗：有人骗别人替他发送口令时，被骗的人会收到"某某设备已登录"的回复，可以马上去设置页让它下线。
- 提示文案在后台设置，例如"私聊机器人发送：登录 482913"。插件怎样识别口令，由插件决定。

### 5.2 一次性链接登录

```mermaid
sequenceDiagram
    actor U as 群友
    participant P as 插件
    participant F as 论坛
    participant B as 浏览器
    U->>P: 请求登录链接
    P->>F: POST /bot/auth/links，X-Act-As 为该群友
    F-->>P: 一次性链接，10 分钟有效
    P-->>U: 私聊发送链接
    U->>B: 打开链接
    B->>F: GET /login/link?token=…
    F-->>B: 确认页，这一步不消耗链接
    B->>F: 点击“确认登录”，POST /auth/link
    F-->>B: 建立会话
```

链接必须点"确认登录"才生效。QQ 会提前抓取聊天里的链接来生成预览，如果打开链接就直接登录，链接会被预览抓取用掉。

### 5.3 QQ 邮箱验证码

1. 浏览器 `POST /auth/email`，提交 QQ 号。
2. 如果是已同步的成员，论坛生成 6 位验证码，发到 `QQ号@qq.com`，10 分钟有效；不是成员也返回成功，但不发邮件。
3. 浏览器 `POST /auth/email/verify`，提交 QQ 号和验证码；校验通过就建立会话，输错 5 次作废。

### 5.4 群里的提问转到论坛

```mermaid
sequenceDiagram
    actor A as 提问的群友
    actor M as 管理员
    participant P as 插件
    participant F as 论坛
    A->>P: 在群里提问，消息 7731
    M->>P: 让 bot 把这条转到论坛
    P->>F: GET /search/similar，可选，先看有没有类似讨论
    P->>F: POST /threads，X-Act-As 为 A，X-Operator 为 M，带 Idempotency-Key 和 source
    F-->>P: 主题 42，标“来自群聊”
    F--)P: 事件 thread.created
    P->>A: 在群里发帖子通知，消息 7735
    P->>F: PUT /bot/messages/group/群号/7735，thread_id 为 42
```

### 5.5 群里的回复同步到论坛

```mermaid
sequenceDiagram
    actor C as 回答的群友
    participant P as 插件
    participant F as 论坛
    C->>P: 引用帖子通知 7735 回复
    P->>F: GET /bot/messages/group/群号/7735
    F-->>P: 主题 42
    P->>F: POST /threads/42/posts，X-Act-As 为 C，source 为 C 的消息
    F--)P: 事件 post.created
```

反过来，论坛上有人回复了来自群聊的内容时，`post.created` 的 `reply_to.source` 带着原消息，插件可以在群里引用原消息，把这条回复转发回去。

### 5.6 通知转到 QQ

```mermaid
sequenceDiagram
    participant F as 论坛
    participant P as 插件
    actor A as 群友
    Note over F: 有人回复或 @ 了 A，A 开启了这类通知的 QQ 提醒
    F--)P: 事件 notification.created，含 A 的 QQ 号和 qq_text
    P->>A: 私聊或在群里 @ 提醒，方式由插件决定
```

### 5.7 成员同步

- 插件启动时和每天定时推送完整名单：`PUT /bot/groups/{group_id}/members`。
- 收到进群、退群、被踢、改群名片、设置或取消管理员的通知时，推送对应的成员变动。
- 论坛据此更新显示名、角色和成员状态，变化写入审计日志，并刷新对应的头像缓存。
- 完整名单比上次少了超过 20% 时，论坛先不处理缺少的人，只记日志，等下一次同步确认，防止接口异常返回不完整的名单。

## 6. 示例

以群友的身份发一个问答帖：

```http
POST /api/v1/threads
Authorization: Bearer <bot token>
X-Act-As: qq:123456789
X-Operator: qq:10001
Idempotency-Key: qq-987654321-7731-thread
Content-Type: application/json

{
  "board": "qa",
  "kind": "question",
  "title": "rank 30% 能冲夏令营吗",
  "content": { "onebot": [
    { "type": "text", "data": { "text": "……" } },
    { "type": "image", "data": { "url": "https://multimedia.nt.qq.com.cn/……" } }
  ] },
  "source": { "chat_type": "group", "chat_id": 987654321, "message_id": 7731 }
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{ "thread": { "id": 42, "url": "https://bbs.mousebaoyan.cn/t/42", … }, "post": { "id": 108, "floor": 1, "via": "qq", … } }
```
