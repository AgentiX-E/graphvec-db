# var-length-path [*0..N] 修复计划

创建时间: 2026-09-02 20:16

## 目标
修复 `MATCH p = (:Label)-[*0..N]->(x)` 变长路径遍历返回 0 行的 bug，从而修复 quantifier 目录 4 个 `[8] on nodes/relationships` 失败场景。

## 根因（已确认）
- `MATCH p = (:SNodes)-[*0..3]->(x)` 返回 0 行，但 `MATCH (n)` 返回 16 个节点。
- 变长路径遍历 `[*0..N]` 未正确产生路径（含零长度 N=0 的情况 `[*0..3]` 应包含直接节点）。

## 步骤
- [ ] 步骤1: 定位 var-length path 的实现位置（var-length-path.ts / graph-engine.ts）
- [ ] 步骤2: 诊断 [*0..3] 为何返回 0 行（最小复现）
- [ ] 步骤3: 修复变长路径遍历（含零长度 + 多跳）
- [ ] 步骤4: 验证 4 个 [8] 场景全绿
- [ ] 步骤5: 核心回归 + 全量 expression 验收
- [ ] 步骤6: Lambertyan 提交

## 当前进度
正在执行: 步骤1（定位实现）
