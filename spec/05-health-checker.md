# GAP-44: HealthChecker — 组件级健康检查增强

**优先级**: P3
**状态**: ✅ 已实现

## 概述

`HealthChecker` 提供细粒度的组件级健康检查，补充现有的 `Health` K8s 三探针。
新增 `/health/live` 和 `/health/ready` HTTP 端点。

## 设计

### 类结构

```
HealthChecker (shardManager, engine)
├── livez() → { ok, timestamp, uptime }
├── readyz() → { ok, timestamp, components[], summary }
├── probeAll() → HealthProbe[]
├── detail() → { timestamp, uptime, components, summary }
├── probeStorage()
├── probeConsensus()
└── probeIndex()
```

### 三类组件探针

| 探针 | 名称 | 检查内容 | 条件 |
|------|------|----------|------|
| 存储 | `storage` | 引擎 stats 可响应 | stats().nodeCount >= 0 |
| 共识 | `consensus` | Raft shard 状态 | 有 Leader、无过多 Candidate |
| 索引 | `index` | 读写能力 | upsertNode + deleteNode 成功 |

### HTTP 端点

| 路径 | 说明 |
|------|------|
| `/health/live` | 存活探针，始终返回 200 |
| `/health/ready` | 就绪探针，全部组件 healthy 时返回 200，否则 503 |

端点在 `rest.ts` 中注册，通过 `config.healthChecker` 传入，可选启用。

### 文件

- `src/api/health-checker.ts` — 实现
- `src/api/health-checker.spec.ts` — 测试

### 测试覆盖

- livez 始终返回 ok
- readyz 全状态测试（healthy / degraded / unhealthy）
- 三组件探针独立测试（healthy / degraded / unhealthy）
- probeAll 应返回所有三个组件
- detail() 结构化详情
- uptime 正确
