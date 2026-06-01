# 关闭 V2 深审 + Raft 成员变更实现 — 执行计划

创建时间: 2026-06-01 17:35

## 目标
1. 更新 V2 报告：已实现项标记 ✅，剩余项重计
2. 实现 Raft 成员变更（AppMembershipManager 三阶段强化）
3. 实现 5 个可实现的剩余 P1/P2 项
4. 确认 4 个"待查/待确认"项

## 并行任务分配

### Agent A: V2 报告更新（主 agent 执行）
- 更新 V2-深审覆盖完成报告.md 中已实现项
- 重新统计最终覆盖数

### Agent B: Raft 成员变更实现（子 agent）
- AppMembershipManager 增强：Leader 存活检查 + 提案锁定 + Remove 安全检查
- 新节点数据预同步
- RouteTable 自动更新
- 测试

### Agent C: P2 剩余项实现（子 agent）
- 向量搜索 fan-out 剪枝（验证无需实现，项目无向量搜索）
- 追踪埋点完整性（待查 → 确认或补）
- 重平衡状态机持久化（已存在 → 确认代码状态）
- 全文增量索引（分析是否需要）

### Agent D: 拼音搜索 + OpenAPI + GraphQL mutation（子 agent）
- 拼音搜索实现（pinyin.ts + spec）
- REST OpenAPI 文档
- GraphQL mutation/subscription

## 当前进度
正在执行: 并行调度 3 个子 agent
