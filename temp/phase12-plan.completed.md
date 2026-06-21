# Phase 12 — 三线并行：Precedence + SHOW INDEXES + 全量回归

创建时间: 2026-06-21 15:50

## 总目标
最高标准完美实现——三件事都要，并行推进。

## 路线

### 方向 A: Precedence 修复（UNWIND+WITH 聚合路径）
- **根因**: Precedence1-3 的 57 fail 全部是 `UNWIND ... WITH collect(...) AS x RETURN all(...) AND any(...) AS result`
- 非布尔表达式问题，是 UNWIND+WITH 聚合管道的问题
- 需要追踪 `_executeWithUnwindPipeline` 的执行路径
- **最小子集**: 跑 Precedence1.feature 的单个 Scenario 确认路径

### 方向 B: SHOW INDEXES / CALL db.labels 执行层
- AST 解析已存在，缺 `_executeViaGraphEngine` 的 dispatch
- `CALL db.labels()` → 遍历 allNodes 返回去重 label 列表
- `SHOW INDEXES` / `SHOW CONSTRAINTS` → 从 `_indexRegistry` / `_constraintRegistry` 读取
- 约 60+ TCK scenarios，独立于其他改动

### 方向 C: TCK 全量回归验证
- 分块策略已验证可行（Clauses 17 → Expressions 18 → useCases）
- 需确认 GE 目录路径复用未引起 DML 测试退化

## 执行策略
1. 先并行：方向 A（子 agent 调试）+ 方向 B（主 session 实现）
2. 方向 C 等待 A+B 都完成后再跑全量
3. 若 A 前置条件不足（需要先修 UNWIND 管道扩展），则在同一个子 agent 中做

## 步骤

- [ ] **A1**: 子 agent spawn — 调试 Precedence Scenario [14] 的 UNWIND+WITH 路径
- [ ] **B1**: 实现 CALL db.labels() 的执行层（最简，直接影响 20+ TCK）  
- [ ] **B2**: 实现 SHOW INDEXES execution layer
- [ ] **B3**: 实现 SHOW CONSTRAINTS execution layer
- [ ] **A2**: Precedence 修复完成
- [ ] **C1**: 全量 TCK 回归验证
