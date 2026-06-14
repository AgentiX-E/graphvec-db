# V16 最优推进路径

创建时间: 2026-06-03 17:33

## 总览

**三路并行策略**：补齐剩余 spec + 功能缺口 + 真实 bugfix

## Phase 1: 补齐缺失 spec（子代理并行执行）

| # | 模块 | 文件 | 行数 | 类型 | 优先级 |
|---|------|------|------|------|--------|
| 1 | storage-classic-level | src/core/storage-classic-level.ts | 451 | 真实 storage provider | **P0** |
| 2 | backup-checksum | src/ops/backup-checksum.ts | 105 | 纯工具函数 | P1 |
| 3 | consensus-factory | src/consensus/consensus-factory.ts | 42 | 工厂模式 | P1 |
| 4 | simulated-raft | src/consensus/simulated-raft.ts | 57 | 模拟器 | P1 |
| 5 | error-codes | src/api/error-codes.ts | 56 | 枚举常量 | P2 |
| 6 | backup-types | src/ops/backup-types.ts | 54 | 纯类型 | P2 |
| 7 | schema-types | src/schema/schema-types.ts | 80 | 纯接口 | P2 |
| 8 | ldbc-queries | src/benchmark/ldbc-queries.ts | 230 | benchmark | P3 |
| 9 | cypher-lite-parser | src/query/cypher-lite-parser.ts | 12 | 极简 | P3 |

## Phase 2: FOREACH runtime 真实实现

现状：parse 已完成（6 tests），但 _executeQuery 中没有执行 FOREACH 的逻辑

## Phase 3: GraphQL Subscription runtime 完善

现状：graphql-subscription.spec.ts 有 6 tests，graphql-adapter.spec.ts 0 tests（只有 describe 块）

## Phase 4: storage-classic-level.spec.ts + GNN 推理增强

- ClassicLevelStorageProvider: StorageProvider 接口的 LevelDB 实现
- GNN inference engine: 现有 16 tests，可补充端到端集成测试

## 绝对禁止
- ❌ Mock虚假实现
- ❌ 只标记Warning不改代码
- ❌ 不写测试就声称完成
