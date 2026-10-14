# 开发约定

写代码时的具体约定，按需阅读。总的规矩见 [AGENTS.md](../AGENTS.md)；表结构的约定见[数据表 · 约定](data-model.md#约定)，接口的约定见[接口 · 约定](api.md#1-约定)。

## 1. 结构与分层

### 1.1 目录

按领域分模块：同一件事的接口、业务逻辑、查询和测试放在一起，改一个功能通常只动一个目录。

```text
app/                    页面（React Router）
  api.server.ts         页面在进程内调用 /api/v1 用的客户端
  routes/               路由模块；只有这个页面用的组件放在路由文件旁边
  components/           两个以上页面共用的组件；ui/ 是 shadcn/ui 的组件
server/
  main.ts               进程入口：用 react-router-hono-server 把 Hono 应用和 React Router 接在一起
  app.ts                组装 Hono 应用：挂上中间件和各模块的路由；接口测试直接对它发请求
  modules/              业务模块，一个领域一个目录
    members/            例：群、成员同步、冻结与恢复
      routes.ts         接口定义：createRoute 和处理函数
      service.ts        业务逻辑；模块对外只暴露这里导出的函数
      service.test.ts
    auth/  users/  boards/  threads/  posts/  uploads/
    search/  notifications/  events/  moderation/  admin/  levels/
  platform/             和业务无关的基础设施：数据库连接、错误类型、日志、设置、邮件、图片处理
db/migrations/          SQL 迁移
db/types.ts             kysely-codegen 从数据库生成的类型
scripts/                bootstrap、mock-bot 等命令
test/                   Vitest 的全局准备：测试用的数据库
```

- 模块里的文件按需拆。小模块有 `routes.ts` 和 `service.ts` 就够了；查询多了再拆出 `queries.ts`，schema 多了再拆出 `schemas.ts`。出现新的领域才新建模块。
- 按领域分，不按调用方分。bot 用的接口放在它操作的领域里，比如成员同步在 `members`，口令确认在 `auth`。
- 文件名用小写加短横线。测试和被测的文件放在一起，命名为 `*.test.ts`。
- `scripts/` 里的命令不经过打包，由 Node 直接运行 TypeScript。所以相对 import 一律写上 `.ts`、`.tsx` 后缀，也不用 enum 这类需要编译的语法；这两条由 oxlint 和 tsconfig 检查。

### 1.2 依赖方向

依赖只能单向：页面 → `/api/v1` → 接口（`routes.ts`）→ 服务（`service.ts`）→ 数据库。不能反过来，也不能跳层。

- **页面**（React Router 的路由模块）：loader 和 action 在进程内调用 `/api/v1`，不直接调用服务，也不查数据库。这样网页能做的事，bot 一定也能做。调用方式是 `context.get(apiContext)` 拿到的 Hono `hc` 客户端：它带着访客自己的 Cookie 等请求头，经 `app.request()` 在进程内完成，类型来自接口定义。登录、退出这类会写 Cookie 的接口，action 要用 `cookiesFrom()` 把 Set-Cookie 转给浏览器。
- 关页面时也要送达的请求（阅读记录）不走 action，由浏览器直接用 `fetch` 加 `keepalive: true` 调 `/api/v1`，页面卸载后请求照样发出。同源请求带着 Cookie 和 Origin，认证和 CSRF 检查照常。
- **接口**（Hono + `@hono/zod-openapi`）：校验参数、认证和鉴权，然后调用服务、返回结果，不写业务逻辑。
- **服务**：业务逻辑都在这里。一个业务动作一个函数，事务也在这里开。服务不碰 HTTP：不读请求头，不返回响应对象，参数是普通的值，出错就抛业务错误。
- **数据库**：用 Kysely 访问，类型由 kysely-codegen 生成。
- `platform` 不依赖任何业务模块，业务模块可以用 `platform`。

### 1.3 模块之间

- 一个模块只通过另一个模块 `service.ts` 导出的函数和它协作，不引用它的内部文件。模块之间不能循环依赖。
- 每张表只由一个模块写入。比如通知只由 `notifications` 写，回复模块要发通知就调用它的函数。读不受限制，查询里可以直接 join。
- 需要在同一个事务里完成的协作，由调用方开事务，被调用的服务函数把事务（Kysely 的 `Transaction`）作为第一个参数接收。
- 不必和主操作同时成败的后续动作，比如 QQ 提醒，通过事件交给订阅方，不在服务里直接调用。

### 1.4 函数和文件

- 规则复杂、又不用读写数据库的逻辑，比如权限判定、OneBot 内容转换、中文分词、Markdown 过滤，写成纯函数：服务负责读数据、调用它、写回结果。这样测它不需要数据库。
- 用函数和模块组织代码。不写类的继承层级（错误类型除外），不用依赖注入容器和装饰器。
- 可变的全局状态只放在少数明确的地方，比如访客页面缓存和浏览数累计，不散落在各处。
- 一个文件超过约 400 行、一个函数超过约 60 行，通常说明它做了不止一件事。按职责拆，不按行数机械地拆。

## 2. 接口

- 每个接口用 `createRoute` 定义请求和响应的 schema，OpenAPI 文档从这里生成，不另外手写。路由用 `platform/http.ts` 的 `createRouter()` 创建，参数校验失败统一返回 `400 invalid_request`，`message` 是 Zod 的中文提示。
- 认证、代操作（`X-Act-As`）、操作人（`X-Operator`）、幂等、限流和审计日志都是公共的中间件或步骤，不在每个接口里各写一遍。规则见[接口 §2](api.md#2-bot-认证与代操作)。
  - 处理函数开头调用 `authorize(c, 范围)` 拿到当前用户，范围就是 bot token 的范围（`read`、`act`、`moderate` 等）。它统一检查 token 范围、冻结、代发开关、角色和操作人，规则是 `platform/access.ts` 里的纯函数。没调用它的接口 bot 只能当访客用；只给网页用的接口调用 `requireWeb(c)`。
  - 限流调用 `platform/rate-limit.ts` 的 `rateLimit(键, 次数, 窗口)`，键用原值拼成，例如 `email:qq:123456:minute`；超出时抛 `429`，带 `Retry-After`。
  - 写操作的服务函数接收 `actorOf(c, viewer)` 得到的 `Actor`（以谁的身份、操作人、token、IP），需要审计时在同一个事务里调用 `recordAudit`。
- `server/app.ts` 里的中间件也作用于页面请求。中间件要给响应加头（比如 Set-Cookie）时，写在 `await next()` 之后：页面由 React Router 返回它自己的 `Response`，`next()` 之前写的头会丢掉。
- 错误码用英文 snake_case，发布后不再改；`message` 用中文，写给人看。新的错误码同时写进 api.md。
- QQ 号只返回给成员、bot 和管理员，访客和冻结的账号看不到。头像一律用 `/avatars/{id}.webp`，不直接用带 QQ 号的头像地址。
- 只返回调用方用得上的字段，正文默认只给 `html`（见[接口 · 约定](api.md#1-约定)）。
- 已发布的接口：加字段可以直接加；删字段、改含义、改错误码属于破坏性修改，先问用户。

## 3. 数据库

- 改表只通过新增 SQL 迁移（`db/migrations/`，按编号执行）。改完运行 `pnpm db:migrate` 和 `pnpm db:codegen`，并更新 data-model.md。上线前可以直接改已有的迁移（改完用 `docker compose down -v` 清掉本地数据库再迁移），上线后已经执行过的迁移不再修改。
- 查询用 Kysely 的查询构建器；它写不出来的用 `sql` 模板，值一律走参数绑定，不拼接字符串。
- 只查需要的列。列表用游标分页，帖子内按楼层号定位，不用 OFFSET。列表要的关联数据一次查出来，不在循环里查库。
- 新查询要有索引支撑，拿不准就看 `EXPLAIN`。新索引和用到它的查询在同一个改动里，并补进 data-model.md 的热点查询表。
- 并发交给数据库处理：唯一约束、`ON CONFLICT`、带条件的 `UPDATE`、行锁。不要先查再写。
- 计数和事件跟业务数据在同一个事务里写。事务里不做网络请求（发邮件、拉头像、下载图片），等事务提交以后再做。

## 4. 前端

- 数据走 loader 和 action，提交用 `<Form>` 或 `useFetcher`。上传图片是例外：编辑器用 `app/browser-api.ts` 直接 `POST /api/v1/uploads`，文件大，经过 action 要多读一遍、多传一次。不用 `useEffect` 拉数据或同步派生状态，不引入全局状态库和请求库（Redux、Zustand、TanStack Query 等）。
- React Compiler 已开启，不手写 `useMemo`、`useCallback`、`memo`。
- 组件先用 shadcn/ui（用它的 CLI 加进仓库再改）；样式写 Tailwind 工具类，除了主题变量不写单独的 CSS。
- 界面控件统一用 `components/ui/` 里的组件：按钮、输入框、下拉框、复选框、单选、开关、对话框、确认框和轻提示。页面里不直接写原生的 `<select>`、复选框和单选框，也不用浏览器的 `confirm`、`alert`、`prompt`：它们的样子跟着系统走，和站点对不上。缺的组件先补进 `components/ui/`，再在页面里用。下拉框（`Select`）和菜单一样，弹出的是站点自己的面板，不是系统的选择列表；确认和填理由用 `confirmDialog`、`promptDialog`，失败提示用 `toast`，都可以在事件处理里直接调用，lint 的 `no-alert` 会拦下浏览器自带的那几个。
- 这些组件要轻。每个页面都会加载的部分不用 Base UI，它的菜单和对话框连同定位库要多出约 40KB gzip：菜单、下拉框和抽屉基于 `components/disclosure.tsx` 手写；对话框和确认框基于原生 `<dialog>`（`showModal()` 自带遮罩、Esc 关闭和焦点管理）；复选框、单选和开关是加了样式的原生 `<input>`。Base UI 只用在这些做不了的复杂控件上（标签页等），它们随路由拆分，只在用到的页面加载。
- 类名冲突要靠 `cn()` 合并才能覆盖（`cva` 只拼接不合并），比如 `buttonVariants({ className: "hidden" })` 已经合并过，可以直接用。
- 字号和尺寸用 rem，不写 px：桌面端（`lg` 以上）的根字号放大到 106.25%，整个界面一起变大。常用的小字号是主题变量 `text-2xs`（11px）、`text-meta`（13px，元信息）、`text-body`（15px，正文和标题）。
- 文案直接写在组件里，不引入 i18n 框架。用正式、简洁的书面语，只写用户用得上的信息；能用图标表达的不写字，图标按钮带 `aria-label`。时间统一按北京时间（`Asia/Shanghai`）显示，这样服务端和浏览器渲染出来的结果一致。
- 先保证手机上好用：大部分人是在 QQ 里点链接打开的，要能在 QQ 内置浏览器里正常使用。
- 表情选择器用 frimousse，打开时才加载。表情数据（emojibase-data 的中文版，约 100KB gzip）在安装依赖时由 `scripts/copy-emoji-data.ts` 复制到 `public/emojibase/{版本}/`，由我们自己提供，不走默认的 jsDelivr（国内不稳定）；路径带版本号，所以服务器给 `/emojibase/` 发一年的缓存（`server/main.ts`）。
- 带宽很紧（[总体设计 §11.2](design.md#112-带宽)）：不用网络字体；不往浏览器里打包大依赖，Markdown 渲染和代码高亮只在服务端做；图片用显示档、懒加载并写明宽高；管理后台的代码只在后台的路由里引用。加前端依赖前，先看它让打包结果大了多少。
- 能点的元素用 `button`、`a`、`form`，不给 `div` 绑点击事件。
- Markdown 只在服务端渲染；插入页面的 HTML 只能是服务端过滤过的 `html` 字段。

## 5. 测试

什么值得测见 [AGENTS.md · 测试](../AGENTS.md#测试)，这里只讲写法。

- Vitest 写服务和接口测试；Playwright 只跑少数关键流程（登录、发帖、回复、后台设置），在 `e2e/`：对着构建好的论坛跑，端口 3300、数据库 `mousehole_e2e` 都是它自己的，每次重建，不碰本地数据；`pnpm e2e` 先构建再跑，第一次要 `pnpm exec playwright install chromium`，CI 在构建之后跑；`pnpm load-test`（`scripts/load-test.ts`）用于[总体设计 §11.4](design.md#114-验收) 的性能验收，不放进 CI。新加常用的页面或接口时，把它加进 `server/indexes.test.ts`，CI 会检查它的查询走索引。
- 涉及数据库的测试连真实的 PostgreSQL 18，不 mock 数据库。`test/` 在全局准备时迁移一个模板库，每个测试文件开始前从模板复制一个自己的库，所以测试文件之间可以并行。同一个文件里的测试共用一个库：每个测试自己准备数据，不依赖其他测试的执行顺序。
- 接口测试用 `hono/testing` 的 `testClient(app)` 发请求，走完整的中间件（认证、代操作、幂等），类型和页面用的客户端一致。带 Cookie 的写请求要像浏览器一样带上 `Origin`，否则会被 CSRF 检查拦下。bot 的完整流程用 `scripts/mock-bot` 跑：开着 `pnpm dev`，先 `pnpm mock-bot setup --owner <你的QQ号>`（建 token、关联演示群、推送假成员，token 存在不进仓库的 `.mock-bot.json`），`pnpm mock-bot seed` 建演示用的版块和标签，再 `pnpm mock-bot demo` 在新的群里逐项检查成员同步和登录流程。新的 bot 接口做好后，在 `demo` 里加上对应的步骤。
- 过期、冷却这类逻辑，直接构造已经过期的数据来测，不 `sleep` 等待。

## 6. 术语

文档、界面文案和接口的 `message` 都用下面的叫法，代码里用右边的英文名。

| 叫法 | 代码 | 含义 | 不要用 |
| --- | --- | --- | --- |
| 版块 | board | 帖子的分区 | 板块、分类 |
| 帖子 | thread | 一整个讨论：标题、主楼和全部回复。发帖就是发一个帖子 | 主题、话题 |
| 楼层 | post | 帖子里的一层，有楼层号（floor）；"3 楼"指楼层号是 3 的那层 | 帖子（指一层时） |
| 主楼 | 1 楼的 post | 帖子的第一层，楼主写的正文 | 首帖 |
| 回复 | 1 楼以后的 post | 主楼之后的楼层；也指回复这个动作，回复某一层时记下回复关系（`reply_to`） | 跟帖、评论 |
| 楼主 | thread 的作者 | 发帖的人。其他楼层的发布者叫作者 | |
| 短评 | boost | 楼层下面一句不超过 16 字的话，不占楼层 | 评论 |
| 表情回应 | reaction | 点赞是其中的爱心 | |
| 标签 | tag | 分话题、院校、方向三类，"话题"只用在这里 | |
| 等级 | level | 论坛的 L0–L5 | 信任等级、群等级 |
| 成员 | member | 在群里、已同步的账号；不在群里的冻结（frozen） | |
| 访客 | guest | 没登录的人和冻结的账号 | 游客 |
| 代发、代操作 | act-as | bot 以某位成员的身份操作 | |
| 草稿 | draft | 编辑器里还没发出的内容 | |
| 转存回执 | notice | bot 把群消息存到论坛后在群里回复的那条消息 | 帖子通知 |
| 个性签名 | bio | 资料里的一句话，默认取 QQ 的 | 简介 |
