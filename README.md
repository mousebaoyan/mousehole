# 鼠洞

四非保研鼠群的论坛。一个 QQ 号就是一个论坛账号；群里的 AstrBot 插件可以通过接口使用论坛的几乎全部功能，并指定以哪位群友的身份操作。

> 目前处于设计阶段，还没有代码，设计评审通过后开始开发。

## 设计文档

| 文档 | 内容 |
| --- | --- |
| [总体设计](docs/design.md) | 目标、已定决策、架构、技术选型、成员资格与同步、登录、内容、管理后台、性能、部署、安全与隐私、路线图 |
| [数据表](docs/data-model.md) | PostgreSQL 表结构、索引和查询约定 |
| [接口](docs/api.md) | 接口清单、bot 代操作、幂等、成员同步、事件流、登录与部署流程 |
| [开发约定](docs/development.md) | 目录、模块划分和分层，以及接口、数据库、前端、测试的写法 |

## 参与开发

先读 [AGENTS.md](AGENTS.md)：项目规矩、文档索引，以及分支、提交和 PR 的约定，人和编码 agent 都适用。

## 技术栈

React 19 + React Router 8 + Hono 全栈（TypeScript 7，Node.js 26），PostgreSQL 18 + Kysely，Docker 部署。选型依据见[总体设计 · 技术选型](docs/design.md#5-技术选型)。

## 相关项目

- [鼠群官网](https://mousebaoyan.cn/)（[源码](https://github.com/mousebaoyan/mousebaoyan.github.io)）

## 许可证

[MIT](LICENSE)
