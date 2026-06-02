# GAP-61: Index 在线重建 — Double-Buffer 交换

**优先级**: P3
**状态**: ✅ 已实现

## 概述

`ColumnarIndex.buildForColumn()` 当前是破坏性重建（先删旧索引再建新索引），
重建期间列索引不可用。增加 Double-Buffer 交换方案实现在线重建。

## 设计

### 1. 架构

```
正常写入                    双缓冲重建
    │                           │
写入 activeDb              写入 replicaDb (重建)
    │                           │
查询 activeDb              完成后原子交换 activeDb ↔ replicaDb
```

### 2. 实现

在 LMDB 同一 RootDatabase 下使用两个不同的子数据库 (sub-db)：

- `columnar` — 默认 active db
- `columnar-rebuild` / `columnar-rebuild-2` — 交替的重建用 db

```ts
buildForColumnDoubleBuffer(col, nodeIterator):
  // Phase 1: 在备用库上全量重建
  _ensureReplicaDb()               // 打开备用 sub-db
  _deleteColumn(col, replicaDb)    // 删除备用库中的旧数据
  for each node:                   // 在备用库中插入新索引
    replicaDb.putSync(key, '1')

  // Phase 2: 原子交换
  activeDb.close()                 // 关闭主库
  activeDb = replicaDb            // 提升备用库为主库
  replicaDb = null                 // 清空备用库引用
```

### 3. 关键属性

- `ColumnarIndex.isRebuilding` — 是否正在重建中
- `ColumnarIndex.config.doubleBufferRebuild` — 是否启用双缓冲（默认 false）
- 未启用时 `buildForColumnDoubleBuffer` 降级为普通 `buildForColumn`

### 4. 设计要点

1. **原子交换**: 关闭旧 activeDb 引用 + 提升 replicaDb 的过程在同一微任务内完成
2. **交替命名**: 使用 `columnar-rebuild` 和 `columnar-rebuild-2` 交替，
   避免多次 rebuild 时命名字段冲突
3. **零停机**: 重建全程 activeDb 持续服务查询，仅在交换瞬间（微秒级）切换
4. **故障安全**: 任何重建异常都在 `_isRebuilding = false` 的 `finally` 中恢复，
   异常时备用库直接被丢弃，activeDb 不受影响
5. **降级兼容**: `doubleBufferRebuild=false` 时平滑退化为普通重建

### 5. API 变更

- `ColumnarIndexConfig.doubleBufferRebuild?` — 配置开关
- `ColumnarIndex.buildForColumnDoubleBuffer(col, nodeIterator)` — 新方法
- `ColumnarIndex.isRebuilding` — 新 getter
- 内部 `_ensureReplicaDb()` / `_swapDatabases()` 方法

### 6. 测试覆盖

| 测试 | 说明 |
|------|------|
| GAP-61-01 | 双缓冲重建后数据正确 |
| GAP-61-02 | 未启用 flag 时降级为普通重建 |
| GAP-61-03 | 重建后数据隔离验证 |
| GAP-61-04 | 跳过 null/undefined 值 |
| GAP-61-05 | 多次 swap 持续可用 |
| GAP-61-06 | isRebuilding 状态正确 |
| GAP-61-07 | 空迭代器产生空索引 |
| GAP-61-08 | swap 后仅包含重建数据 |
| GAP-61-09 | 普通 build 数据持久化不受影响 |
