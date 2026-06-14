# Phase 7: 代码审查 + DML 测试 + 性能基线 + 文档

## 原则
- 最高标准，绝不妥协
- 并行推进独立任务
- 每完成一步 checkpoint commit

## 任务矩阵

```
P1 代码审查 ───── 全量 _executeViaGraphEngine 代码审查
P2 DML 测试 ───── 补齐 MERGE/DELETE/SET vitest 用例
P3 性能基线 ───── 大图 10万+ 节点的 QPS/延迟基准
P4 文档 ───────── README + TCK 覆盖矩阵 + API 文档
```

## Phase 7a: 并行启动

### P1: 代码审查 sub-agent
- 审查 `_executeViaGraphEngine`（~1600 行核心函数）
- 重点：filter 架构、跨变量引用、DML 路径、_formatResultRow
- 输出：漏洞清单 + 修复建议（优先级排序）

### P2: DML 测试 sub-agent
- 构建 `src/query/query-engine-dml.spec.ts`
- 覆盖：CREATE/MERGE/DELETE/SET 的 TCK 等价验证
- 使用 `_executeQuery`（同步路径）+ allNodes 断言

### P3: 性能基线 sub-agent
- 构建 `src/benchmark/query-benchmark.spec.ts`
- 场景：10K/100K/1M 节点 + 1-hop/2-hop/3-hop traversal
- 输出：QPS / p50/p95/p99 latency

### P4: 文档
- README.md 基础架构 + 快速开始
- 等待前三项结果后整合

## 当前进度

### 完成 (15:50~16:00)
- [x] 代码审查 sub-agent `ae4ac4ae`（_executeViaGraphEngine 全量审查）→ 报告已保存
- [x] DML 测试文件 `query-engine-dml.spec.ts` → 15/15 全绿
- [x] 基准测试 sub-agent `0e3f6434` → GE 原生 API 10K~100K 节点性能基线
- [x] **C1**: Plan 深拷贝（JSON.parse(JSON.stringify)）在 _executeQuery 入口
- [x] **C2**: REMOVE 属性删除 side-effect 实现 + 死代码修复
- [x] **H3**: WHERE type(r) 全局正则匹配（支持复合条件）
- [x] **H5**: extractEdgesFromNodes 字符串索引兼容（Number() 转换）
- [x] **H6**: ORDER BY null 排序方向修正（抛 openCypher 规范）
- [ ] 回归验证（sub-agent 运行中）
- [ ] P4 文档（等待回归通过后整合）

## 计划文件

scripts/phase7-plan.md（本文件）
