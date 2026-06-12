# Phase 4 Post — 规划

## Phase A: 清理（~2 min）

### A.1 删除 openCypher-tck.spec.ts 残骸
- 删除 `src/query/cypher-tck/openCypher-tck.spec.ts`（9255 行，已被 55 分片替代）
- 删除 `src/query/cypher-tck/openCypher-tck.spec.ts.bak`
- 删除 `src/query/cypher-tck/openCypher-tck.spec.ts.backup`

### A.2 清理 query-engine.ts 中的 peggy 注释
- 搜索 `peggy`, `PEG`, `peggyParser` 等残留注释（无功能影响，只是注释清理）

## Phase B: GraphEngine 主流程集成（待评估）

### 现状
```
parseQuery() ──→ ANTLR parseCypherToPlan() → buildQueryPlan()
    │
_executeQuery() ──→ _tckEnsureDaemon() → daemon HTTP → GraphEngine(dist)
                    └→ daemon not found → _legacyPegParseQuery() [DEAD]
```

### 问题
1. _executeQuery 100% 依赖 tck-daemon（HTTP IPC）
2. 兜底路线的 _legacyPegParseQuery 随 PEG 删除已死
3. 实际前端集成（非测试环境）时，需要直接调用 GraphEngine

### 评估方案
**方案：native GraphEngine call**
- 在 `query-engine.ts` 的 `_executeQuery` 中，直接 `import`/`require` GraphEngine（而非通过 daemon IPC）
- 使用 ts 编译后的 dist 版本 `require('../../dist/src/core/graph-engine')`（和 daemon 一样）
- 每个测试 request 创建/销毁 Geo 实例（和 daemon 一样的隔离逻辑）
- 把 daemon 的 `planToQuery` + `_postProcess` 搬到 TS

**优点**：
- 消除 daemon 启动竞态（根本解决）
- 消除 daemon HTTP/curl IPC 开销（~20ms → ~2ms）
- 前端集成可直接用

**缺点**：
- 需要写 ~300-400 行 TS
- `planToQuery`（128 行 JS）→ TS 化
- `_postProcess`（80 行 JS）→ TS 化
- 依赖 dist 目录（需要 `tsc` 后测试）

### 风险
- GraphEngine 的 `require` 路径问题（ESM/CJS）
- `overgraph-storage` 可能在没有 daemon 的独立进程中加载失败

### 决策点
Lambert 决定：
□ 继续 Phase B（native GraphEngine 集成）
□ 先凑合用 daemon（当前 351/351 稳定）
□ 其他
