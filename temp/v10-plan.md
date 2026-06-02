# V10 实现计划 — 4 个 GAP

创建时间: 2026-06-02 14:17

## 目标
完成 4 个 P3 GAP 的实现，不降低现有通过率。

## 各 GAP 状态

### GAP-46 审计日志计数器 + 导出
- [x] src/ops/audit-exporter.ts: AuditLogExporter — JSONL/JSON/CSV 格式导出
- [x] src/ops/audit-exporter.spec.ts: 测试
- [x] 写 spec: spec/03-audit-exporter.md

### GAP-47 自定义聚合函数
- [x] src/query/aggregation-registry.ts: AggregationRegistry
- [x] src/query/aggregation-registry.spec.ts: 测试
- [x] 写 spec: spec/04-aggregation-registry.md

### GAP-48 多语言 SDK
- [x] sdk/python/ 升级为 httpx 异步包
- [x] sdk/java/ 创建 Java SDK 骨架
- [x] sdk/python/test_client.py: 测试
- [x] 每个 SDK 包含 README

### GAP-44 健康检查增强
- [x] src/api/health-checker.ts: HealthChecker — 组件级探针
- [x] src/api/health-checker.spec.ts
- [x] 注册 /health/ready, /health/live 路由（在 rest.ts）
- [x] 写 spec: spec/05-health-checker.md

## 当前进度
正在执行: 所有 GAP
