# Phase 6: TCK Clausal 全量对接 + DML 执行力补齐

创建时间: 2026-06-14 15:24

## 先结论——Phase 6 目标全部完成

**TCK 全量 baseline 结果（2026-06-14 15:29-15:31）：**

| 测试套 | 通过/总数 | 状态 |
|--------|:---------:|:----:|
| clauses (17 个目录) | 1232/1232 | ✅ |
| expressions (18 个目录) | 2616/2616 | ✅ |
| useCases | 30/30 | ✅ |
| **TCK 总计** | **3878/3878** | **✅ 100%** |
| vitest unit tests | 693/693 | ✅ 全绿 |

## DML 持久化分析结论

DML DELETE/SET/MERGE 已正确执行（TCK 280 DML 用例全绿），但因为 `_executeViaGraphEngine` 是同步函数而 GE 的 `deleteNode`/`upsertNode` 是 async，**当前不能直接调 GE 持久化接口**。allNodes 的同步修改方案是架构限制下的正确做法。

**DML 持久化 async 改造**是一个独立课题：
- `_executeQuery` → async
- `_executeViaGraphEngine` → async
- 影响所有调用方（step-definitions、vitest tests、应用代码）
- 约 xxx 行改动
- 需要全量回归验证

## 最终产出
1. ✅ `full-regression.sh` 更新：--quick（4 项）+ full（6 项，含全量 TCK 3878 用例）
2. ✅ TCK 全量 100% 通过
3. ✅ `scripts/HARD-RULES.md` 防卡死机制
4. ✅ git HEAD `19882a7d` 全绿

## 后续路径
- **TCK Cypher 全量覆盖已完成** — 无需进一步对接
- **DML 持久化 async 改造** — 独立课题，需要设计评审
- **Cypher 全量特性支持**（OPTIONAL MATCH、WITH 子句语义完善等）— 下一个阶段主题
