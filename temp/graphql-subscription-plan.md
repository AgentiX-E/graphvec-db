# GraphQL subscription 实现计划

创建时间: 2026-06-01 19:28

## 目标
GraphQL adapter 增加 subscription 支持，通过 SSE（Server-Sent Events）暴露图变更事件，
在单机和分布式场景下都能正常工作。

## 设计
- **传输协议**: SSE（Server-Sent Events），不引入新依赖（内置 http + EventEmitter）
- **事件源**: EventBus.local 的 `node:created/updated/deleted`、`edge:created/updated/deleted`
- **API 端点**: `/api/v1/:db/graphql/subscribe?events=node:created,node:deleted`
- **SSE 格式**: `event: node:created\ndata: {"id":1,"type":0,"name":"Alice"}\n\n`
- **GraphQL 查询格式**: `subscription { nodeCreated { id name } nodeDeleted { id } }`

## 步骤

- [x] 步骤1: 创建 `graphql-subscription.ts` — SSE + EventBus 订阅管理器
- [x] 步骤2: 创建 `graphql-subscription.spec.ts` — 单元测试
- [x] 步骤3: 集成 SSE 路由到 rest.ts
- [x] 步骤4: 运行全量回归测试
- [x] 步骤5: 提交代码 + 更新 V2 报告

## 约束
- 不引入新 npm 包
- SSE 直接用 Node.js http 模块实现
- EventBus 的 on/off 需要 cleanup（断开连接移除 listener）
