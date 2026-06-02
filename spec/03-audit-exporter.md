# GAP-46: AuditLogExporter — 审计日志导出

**优先级**: P3
**状态**: ✅ 已实现

## 概述

`AuditLogExporter` 从 `AuditLog` 中读取审计条目，支持导出为三种格式。

## 设计

### 类结构

```
AuditLogExporter (source: AuditLog | AuditLogger)
├── export(path, format, filter?) → ExportResult
├── scheduleExport(intervalMs, format, targetDir, filter?) → Timer
```

### 导出格式

| 格式 | 扩展名 | 说明 |
|------|--------|------|
| `jsonl` | `.jsonl` | 每行一个 JSON 对象，兼容各种日志收集系统 |
| `json-array` | `.json` | 包含 `meta` 和 `entries` 字段的 JSON 数组 |
| `csv` | `.csv` | CSV 格式，含 header 行，特殊字符正确转义 |

### 过滤条件

- `startTime` / `endTime` — 时间范围（支持 Date 或 timestamp）
- `operations` — 操作类型列表
- `users` — 用户名列表
- `results` — 结果类型列表（success/denied/error）

### 文件

- `src/ops/audit-exporter.ts` — 实现
- `src/ops/audit-exporter.spec.ts` — 测试

### 测试覆盖

- 三种格式导出验证
- 五种过滤条件（operation, user, result, time range, 组合）
- 空日志导出
- CSV 特殊字符转义
- scheduleExport 定时导出
