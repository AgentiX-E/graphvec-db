# DML Async 双轨制设计方案

## 问题

`_executeViaGraphEngine` 是同步函数。DML（DELETE/SET/MERGE）在当前只改 `allNodes`（内存数组），不调 `ge.upsertNode()` / `ge.deleteNode()`，因为后者是 async。结果：DML 语义在 query-engine 层正确，但底层 GE 存储不感知。

## 方案：双轨制

```
execQuery → parseQuery → _executeQuery → _executeViaGraphEngine
                                                      │
                                            ┌───────同步──────┐
                                            ▼                ▼
                                    1. 处理查询        2. 修改 allNodes
                                    (已有)             (已有)
                                            │
                                            └─── 异步副通道 ───
                                                      ▼
                                            3. DML 在后台同步到 GE
```

**同步主通道**（不变）：
- `_executeViaGraphEngine` 保持同步，改 `allNodes`
- 调用方不用改

**异步副通道**（新增）：
- `_executeViaGraphEngine` 返回前，把 DML 操作记录到 `_pendingDMLEffects`
- 返回后，`_executeQuery` 的调用方如果传了 `ge` 实例，调用 `_syncDMLToGe(ge, plan)`

## 实现细节

### 1. 新增 `_pendingDMLEffects` 队列

```typescript
interface PendingDMLEffect {
  type: 'DELETE_NODE' | 'UPSERT_NODE' | 'DELETE_EDGE' | 'UPSERT_EDGE'
  nodeIndex?: number
  id?: number // GE node id
  props?: Record<string, unknown>
}
```

在 `_executeViaGraphEngine` 的 DML 分支中，改 allNodes 的同时 push effect。

### 2. 新增 `_syncDMLToGe`

```typescript
async function _syncDMLToGe(ge: GraphEngine, effects: PendingDMLEffect[]): Promise<void> {
  for (const effect of effects) {
    switch (effect.type) {
      case 'UPSERT_NODE':
        await ge.upsertNode(effect.id!, '', { props: effect.props })
        break
      case 'DELETE_NODE':
        await ge.deleteNode(effect.id!)
        break
    }
  }
}
```

### 3. `_executeQuery` 增强

```typescript
export function _executeQuery(plan: QueryPlan, nodes, query?, ge?: GraphEngine): QueryResult {
  const result = _executeViaGraphEngine(planCopy, nodes, query)
  if (ge && _pendingDMLEffects.length) {
    // 后台触发同步（不 await，fire-and-forget）
    _syncDMLToGe(ge, _pendingDMLEffects.splice(0)).catch(e => console.error('DML sync failed:', e))
  }
  return result
}
```

## 验证

1. 全量回归 715/715 必须零退化（双轨制不改同步路径）
2. 新增 DML sync 测试：执行 DELETE/SET/MERGE 后，通过 GE 原生 API 确认存储层变化
3. TCK DML 场景验证（280 场景）

## 工作量估计

- 接口定义 + effect 收集: ~30 行
- `_syncDMLToGe` 实现: ~25 行
- `_executeQuery` 增强: ~10 行
- 测试: ~30 行
- 总计: ~95 行代码，45 分钟
