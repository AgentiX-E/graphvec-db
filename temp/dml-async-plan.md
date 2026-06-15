# DML Async 全链路改造计划

## 目标
将 DML（DELETE/SET/MERGE/REMOVE）从同步 hack（绕过 GE storage）改为全 async 链路，
使所有 DML 操作真正写入 GE 存储层。

## 架构现状
- `_executeViaGraphEngine` 是 **sync 函数**（line 1638）
- GE 的 `deleteNode(id)`, `upsertNode(props)` 是 **async**
- 当前 DML 在 sync 上下文中调用 `ge.storage.upsertNode/deleteNode`（同步 bypass）
- ~200 个调用 `_executeQuery` / `_executeViaGraphEngine` 的点

## 改造策略：自底向上，不做全量接口变更

### Phase 1: 新建 async 内核（不碰现有接口）
- 新建 `_executeViaGraphEngineAsync`（async 版本，复制修改）
- 将 GE async 调用（getNode/upsertNode/deleteNode）都 await
- 保留旧的 `_executeViaGraphEngine` 作为 sync 包装（内部转发到 async 版本）

### Phase 2: 迁移调用点
- 所有 GE 内部调用点改为 async
- `_executeQuery` 改为 async → 返回 Promise<QueryResult>

### Phase 3: 暴露新接口
- `executeQueryAsync` 对外导出
- 测试同步适配

## 风险
- GE `deleteNode` 涉及大量内部状态（_labelIndex, _nodeCache, _fulltext, _inDegrees）
- `_executeViaGraphEngine` 3000+ 行，迁移工作量大

## 当前进度
正在执行: 计划阶段
