# P1 闭包执行计划

创建时间: 2026-06-01 20:37

## 目标

关闭深度对比审查中所有 P1 项（~12项），含代码修改 + 测试

## 执行策略

按「预估工作量从小到大」排序，分批并行推进。

### Batch 1 — 简单修复（可并行子 agent）

- [ ] **P1-S6**: JS 层 `_nodeIds` 与 OverGraph 重复维护 → 检查是否已解决
- [ ] **P1-S7**: 备份路径格式不一致 → 统一为 .tar.gz
- [ ] **P1-Q7**: 默认 LIMIT 缺失 → 添加 DEFAULT_LIMIT=1000
- [ ] **P1-Q8/Q9**: OPTIONAL MATCH / WITH 脆弱 → 用解析器而非正则
- [ ] **P1-A3**: 游标分页 → `/api/v1/:db/nodes/cursor` 端点
- [ ] **P1-A6**: gRPC Update 端点
- [ ] **P1-A4**: 错误码体系 → ErrorCode 枚举

### Batch 2 — 需要子 agent 分析

- [ ] **P1-S4/S5**: WAL 全量加载 + 双 WAL → 分析实际影响
- [ ] **P1-D1**: 2PC 协调者 WAL 持久化 → CrossShardTransactionManager 分析
- [ ] **P1-O1/O2**: JWT 认证 + API Key 恢复
- [ ] **P1-O3**: 静态加密
- [ ] **P1-O4**: 审计日志持久化

### Batch 3 — 算法优化

- [ ] **closeness shift()** → index pointer (同 P0-11 模式)
- [ ] **wcc/scc 内存优化** → 避免 graphology 复制
- [ ] **louvain Phase 2** → 层次聚簇

## 当前进度

正在执行: Batch 1 — 并行 sub-agent 分析
