# 鼠洞

四非保研鼠群的论坛。一个 QQ 号就是一个论坛账号；群里的 AstrBot 插件可以通过接口使用论坛的几乎全部功能，并指定以哪位群友的身份操作。

> 目前处于设计阶段，还没有代码，设计评审通过后开始开发。

## 设计文档

| 文档 | 内容 |
| --- | --- |
| [总体设计](docs/design.md) | 目标、已定决策、架构、技术选型、身份与权限、登录、内容、性能、部署、安全与隐私、路线图 |
| [数据表](docs/data-model.md) | PostgreSQL 表结构、索引和查询约定 |
| [接口](docs/api.md) | 接口清单、bot 代操作、幂等、QQ 消息映射、事件流、登录与同步流程 |

## 技术栈

Nuxt 4（Vue 3 + TypeScript）全栈，PostgreSQL 18 + Drizzle ORM，Docker 部署。

## 相关项目

- [鼠群官网](https://mousebaoyan.cn/)（[源码](https://github.com/mousebaoyan/mousebaoyan.github.io)）
