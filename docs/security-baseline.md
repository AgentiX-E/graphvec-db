# AgentiX GraphVec 安全基线 v1.0

> 创建：2026-05-29
> 对应模块：`src/security/`, `src/ops/`

---

## 1. 传输安全

### TLS（节点间通信）
- 位置：`src/security/tls.ts`
- 支持模式：TLS 1.2+ / mTLS
- 配置：cert + key + CA（可选 mTLS）
- 当前状态：✅ 已实现

### CURVE（ZeroMQ 消息）
- 位置：`src/core/event-bus.ts`
- 认证机制：ZMQ CURVE 密钥对（pub/secret）
- 边界测试：8/8 项 ✅
- 密钥管理：通过 `curveDir` 文件目录

### mTLS 认证引擎
- 位置：`src/security/auth.ts`
- 能力：chokidar 热加载 + identities 文件
- 当前状态：✅ 已实现（~476 行）

## 2. 访问控制

### 行级安全（RLS）
- 位置：`src/security/rls.ts`
- 能力：策略引擎（已实现但未对接 REST API）
- 当前状态：🟡 基础

### RBAC
- 当前状态：⬜ 未实现（仅基本角色检查）
- 计划：P2（资源级 ACL）

## 3. 数据安全

### 持久化加密
- LMDB：依赖操作系统文件权限
- WAL：明文存储（未加密）
- 当前状态：⬜ 文件级加密未实现

### 备份校验和
- 位置：`src/ops/backup-checksum.ts`
- 能力：备份文件完整性校验
- 当前状态：✅ 已实现

## 4. 审计日志

### 结构化审计
- 位置：`src/ops/audit-log.ts`（pino 结构化日志）
- 内容：操作时间 / 操作类型 / 用户 / 资源 / 结果
- 当前状态：✅ 已实现
- 已知限制：无日志轮替 ✅（pino 内置滚动）

### 审计触发
- 位置：`src/security/audit.ts`
- 状态：🟡 基础（触发器对接需扩展）

## 5. 合规基线 checklist

| 检查项 | 状态 | 备注 |
|--------|:----:|------|
| 传输加密（TLS 1.2+） | ✅ | 节点间通信 |
| 消息认证（CURVE） | ✅ | ZMQ ROUTER-DEALER |
| 节点间 mTLS | ✅ | 热加载认证引擎 |
| 行级安全 | 🟡 | 策略引擎可用，未对接 API |
| RBAC 细粒度 | ⬜ | 待实现 |
| 审计日志 | ✅ | pino 结构化 |
| 备份完整性校验 | ✅ | checksum 验证 |
| 持久化加密 | ⬜ | 文件级加密未实现 |
| 安全配置热加载 | ✅ | chokidar 监听 |
| 证书过期监控 | ✅ | cert-monitor（ops 模块） |

---

## 参考文档

- `src/security/auth.ts` — mTLS 认证引擎
- `src/security/tls.ts` — TLS 配置
- `src/security/rls.ts` — 行级安全策略
- `src/core/event-bus.ts` — CURVE 安全
- `src/ops/audit-log.ts` — 结构化审计日志
- `src/ops/backup-checksum.ts` — 备份校验和
- `WHT-graphvec-audit-compiled-v1.md` — 审计编译报告
