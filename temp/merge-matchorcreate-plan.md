# MERGE match-or-create 核心语义 执行计划

创建时间: 2026-09-17 22:40

## 目标
实现 MERGE 节点的「先按 label+props 查找匹配、否则创建」语义，替换当前「mergeNodes → createNodes 直接降级为 CREATE」的错误实现。

## 根因
- `query-parser.ts:437` 将 `mergeNodes` 直接 push 到 `createNodes`，使 MERGE 完全等价于 CREATE（总是新建）。
- `_executeViaGraphEngine` 的 createNodes 循环无「查找已有匹配节点」逻辑。
- 结果：`MERGE (a:TheLabel) RETURN a.id`（已存在应复用）→ 新建无 id 节点；`MERGE (a {num:43})`（42≠43 应新建）→ 复用了已有节点。

## 正确语义（openCypher）
对每个 mergeNode（按序）：
1. 在 allNodes 中查找匹配节点：label 全匹配 + props 全匹配（key 都存在且 value 相等）
2. 找到 → 绑定 alias 到该节点（不新建），标记 matched=true
3. 未找到 → 新建节点，标记 matched=false

对 mergeEdge（关系）：
1. 源/目标节点已解析（可能新建可能复用）
2. 查找源→目标（或双向，视 direction）之间 label 匹配的边
3. 找到 → 复用；未找到 → 新建边

ON CREATE SET：对标记 matched=false 的节点执行
ON MATCH SET：对标记 matched=true 的节点执行

## 步骤
- [ ] 步骤1: 在 `_executeViaGraphEngine` 的 createNodes 循环之前，为 MERGE 节点实现 match-or-create（先查找、后新建）
- [ ] 步骤2: 修复节点属性写入（props 正确展开，解决 `a.num:''` 问题）
- [ ] 步骤3: 修复 ON CREATE / ON MATCH 分支判定（依 matched 标志而非 newlyCreated.length）
- [ ] 步骤4: 修复 label 合并（ON CREATE SET n:Foo → 追加 label）
- [ ] 步骤5: 实现关系 MERGE（建边 match-or-create）
- [ ] 步骤6: 实现编译期校验（re-binding、无 type 关系、var-length in MERGE、ON clause undefined var）
- [ ] 验收: merge 组回归 + 核心 4 spec 回归全绿
- [ ] 提交（Lambertyan，英文）

## 当前进度
正在执行: 步骤1（match-or-create 查找逻辑）

## 关键文件
- `src/query/query-executor.ts` — createNodes 循环 ~line 2107
- `src/query/query-parser.ts` — mergeNodes→createNodes ~line 437
- `src/query/executor-dml.ts` — _buildDmlRows
- `src/query/ast-to-plan-v2.ts` — extractMerge ~line 2226

## 已修复
- [x] `_buildDmlRows` aggregate 分支 `agg.fn` → `agg.function`（`MERGE (n) RETURN count(n)` 0→1）
