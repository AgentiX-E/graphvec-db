# Phase B: GraphEngine 原生集成 — 最终方案（v2）

## 核心修正

**不需要 createTempGraphEngine，不需要 require(dist)，零序列化。**

```
query-engine.ts (TS)
    │
    ├── import { GraphEngine } from '../core/graph-engine'    ← 和项目其他模块一样
    │
    └── _executeQuery(plan, nodes)
            │
            ├── daemon 路径（保留供淘汰过渡）
            │
            └── _executeViaGraphEngine(plan, nodes) [新增]
                    │
                    ├── new GraphEngine(config)                 ← 直接创建
                    ├── ge.query(planToQuery(plan))             ← 纯 Cypher 字符串
                    └── postProcessResults(result, plan)        ← 纯内存
```

**完全没有序列化步骤。** planToQuery 输出 Cypher 字符串、ge.query 接收字符串、postProcess 处理数组——全在同一个进程，同一个堆上。

## 具体改动

### 1. query-engine.ts 顶部加 import

```typescript
import { GraphEngine } from '../core/graph-engine'
import { OverGraphConfig } from '../types'
```

### 2. 移植 planToQuery

把 daemon 的 `planToQuery`（~158 行 JS）直接移植为 TS 函数，放在 query-engine.ts 底部。

就是字符串拼接——MATCH → `MATCH (n:${label})`，filter → `WHERE n.prop op val`，aggregate → `RETURN func(n.prop)`。

### 3. 移植 _postProcess

ORDER BY → `result.sort()`，SKIP/LIMIT → `result.slice()`，HAVING → `result.filter()`。

### 4. _executeQuery 修改

```typescript
export function _executeQuery(plan, nodes) {
  // 现有逻辑：UNION / MERGE / 原生 filter
  if (plan.unionType) { ... }
  if (plan.type === 'MERGE') { ... }

  // TCK/GraphEngine 路径
  if (nodes?.length > 0 && typeof nodes[0]._label === 'string') {
    // 先试 daemon（快，已存在的 HTTP 进程）
    const r = _tckExec(plan, nodes)
    if (r && r.length > 0) return r
    // 兜底：直接调 GraphEngine
    return _executeViaGraphEngine(plan, nodes)
  }

  // 现有原生处理...
}
```

### 5. _executeViaGraphEngine

```typescript
function _executeViaGraphEngine(
  plan: QueryPlan,
  nodes: Array<Record<string, unknown>>,
): QueryResult {
  // SHOW / ADMIN 命令不经过 GraphEngine
  if (plan.show) return execShow(plan, nodes)
  if (isAdminCommand(plan)) return execAdmin(plan, nodes)

  // plan → Cypher 字符串
  const cypher = planToQuery(plan)

  // 创建引擎 + 导入数据
  const engine = new GraphEngine(createTestConfig())
  try {
    seedData(engine, nodes)
    const result = engine.query(cypher)
    return postProcessResults(result, plan)
  } finally {
    engine.close?.()
  }
}
```

## 影响范围

| 文件 | 改动 |
|------|------|
| `src/query/query-engine.ts` | + import + _executeViaGraphEngine + planToQuery + _postProcess |
| `src/query/tck-daemon.js` | 不变（保留作为可选性能路径） |
| `src/core/graph-engine.ts` | **无改动** |

## 风险

1. **循环依赖**: `src/query/` import `src/core/` 没问题（`src/core/` 不 import `src/query/`）。已验证。
2. **GraphEngine constructor**: 需要 `OverGraphConfig` + 可选的 storage。看 daemon 的 `createEngine()` 怎么传参，照做。
3. **同步 query()**: `ge.query()` 签名是同步的 `NodeRecord[]`，没问题。
4. **导入 nodes**: daemon 是用 SQL-like INSERT 导入的。需要确认 TS 侧 seed 逻辑（现有 daemon 中的 insertNodes 函数）。

## 验证方法

1. 写代码 + tsc 编译
2. `npx vitest run .../split/tck-TCK___*.spec.ts` → 结果应与 daemon 路径一致
3. 跑 3 轮确认无 flaky

---

这个方案没有多余的抽象层，没有序列化绕路，就是 GraphEngine 和 query-engine 该有的直接集成方式。可以开始写代码了吗？
