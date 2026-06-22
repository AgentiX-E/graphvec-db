# Phase 14 执行计划 — DML 持久化 async 改造

基线：40/40 PASS (commit `b048b1f6`)
创建时间: 2026-06-22 13:25

## 目标
消除 `allNodes` 同步修改 → GE 存储层 `upsertNode/deleteNode` async await 持久化路径

## 依赖图

```
_executeViaGraphEngine (async 声明但 body 同步)
  ├─ 节点扫描 → GE._scanAll/_scanNodesByLabel (同步) → 不需改
  ├─ 边构建 → GE.storage.upsertEdge (同步) → 不需改
  ├─ GE 执行 → GE._executeQueryPlan (async/同步混合) → 检查
  ├─ GE 结果处理 → GE 返回后同步过滤 → 不需改
  ├─ CREATE nodes → GE.upsertNode async → 需 await
  ├─ CREATE edges → GE.upsertEdge sync → 不需改  
  ├─ SET props → allNodes 同步改 + GE.upsertNode try-catch → 需 await
  ├─ DELETE nodes → allNodes 同步删 + GE.deleteNode → 需 await
  ├─ REMOVE props → allNodes 同步删 + GE.upsertNode try-catch → 需 await  
  └─ MERGE → CREATE 路径 → 需 await

spec 调用点:
  - query-engine.spec.ts → compileCypher().execute() async 已有
  - cypher-tck/step-definitions.ts → compileCypher().execute() async 已有
  - 其他 spec 78 个文件 ~15-20 个直接调 query-engine → 需检查
```

## 步骤

### Step 1: 分析 _executeViaGraphEngine 全量调用点
- [x] `_executeQuery` 是 async export，不需要改签名
- [x] TCK step-definitions 用 `await execute()` — 已 async
- [ ] query-engine.spec.ts 所有 `execute()` 调用确认已 await

### Step 2: DML 持久化实现
- [ ] CREATE nodes → `await ge.upsertNode()`, 获取 realId → 更新 geIdMaps
- [ ] SET props → `await ge.upsertNode()` 同步 GE 存储
- [ ] DELETE nodes → `await ge.deleteNode()` 同步 GE 存储
- [ ] MERGE → CREATE 路径 async await
- [ ] REMOVE → `await ge.upsertNode()` 同步 GE 存储

### Step 3: 消除 _geInstanceRegistry 缓存（每次重建 GE）
- `_geInstanceRegistry` 存在原因是 async 不可用 → 改为创建后持久化
- GE 实例建立后不复用 `allNodes` → 用 GE storage 唯一数据源

### Step 4: 全量回归确认

## 风险控制
1. 每次 DML 改动后跑 `--quick` 回归（vitest + old TCK top-level + MatchWhere）
2. 改动全部完成后跑 full-regression
3. 不要在主 session 等 vitest 跑完（sub-agent + background）
4. 每一步完成即 git commit

## 当前进度
正在执行: Step 1 — 分析 DML 代码路径
