# EventStream 集成 — GraphEngine → EventStream 对接

创建时间: 2026-05-24 09:12

## 目标

将 GraphEngine 中的 `emitBus()` 替换为 `EventStream`，实现：
- 所有变更事件（node:created, node:deleted, edge:created, edge:deleted）自动写入 WAL
- 远程节点自动 ACK / 去重 / 重试 / 追赶

## 设计

### 方案：GraphEngine 可选接受 EventStream

```typescript
class GraphEngine {
  constructor(config, storage?, eventStream?) 
  // 当 eventStream 传入时，emit 走 EventStream
  // 当 eventStream 未传入时，回退到旧的 EventBus.emit()
}
```

### 改动点

1. **`src/core/graph-engine.ts`**
   - 构造函数新增可选 `eventStream?: EventStream`
   - `emitBus()` 改为 `_emit(event)`: 有 eventStream 则调用 `eventStream.emit()`，否则用旧 `getEventBus().emit()`

2. **不需要改动 `EventStream` / `StreamWal` / `EventBus`** — API 已对齐

### 验证

- 单元测试新增：EventStream 集成测试（用 MockEventBus + 真实 WAL 目录）
- 全量 844+ 不破

## 当前进度

- [x] Phase 1: GraphEngine 构造函数 + _emit 改动
- [x] Phase 2: 集成测试（3/3 passed）
- [x] Phase 3: 全量验证（**52 suites, 847/847 passed, tsc 0 errors**）

## 完成时间

2026-05-24 09:24 GMT+8
