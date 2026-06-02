# OverGraph 分布式架构可执行优化计划

> 基于 2026-05-27 代码审查结果，按 Phase 组织执行计划。
> 每个 Phase 包含：目标、工作内容、验收标准、预估工时。

---

## Phase 0: 工程基座（预估: 0.5d）

**目标**: 消除由默认配置导致的数据不一致风险，建立 Vitest 测试基础设施。

### Task 0.1 — 移除 StandaloneConsensus 默认 fallback

**文件**: `src/shard/range-instance.ts:49-50`

```typescript
// 从: const cp = consensus ?? new StandaloneConsensus(...)
// 改为: const cp = consensus  // 强制要求传入 ConsensusProvider
```

**验收标准**:
- [ ] `RangeInstance` 构造函数要求 `consensus` 为必传参数（非可选）
- [ ] 所有调用 `new RangeInstance(...)` 的测试代码传入显式 ConsensusProvider
- [ ] 编译通过，现有测试不中断

### Task 0.2 — 清理 Jest 残余

**文件**: 全局

| 项目 | 操作 |
|------|------|
| `jest.config.ts` | 删除 |
| `jest.no-coverage.config.ts` | 删除 |
| `jest.integration.config.ts` | 删除 |
| `jest-int.config.ts` | 删除 |
| `jest.curve.config.ts` | 删除 |
| `jest.fault-injection.config.ts` | 删除 |
| `@types/jest` (`^29.0.0`) | 从 devDependencies 移除 |
| `jest` (`^29.0.0`) | 从 devDependencies 移除 |
| `ts-jest` | 从 devDependencies 移除 |
| package.json 中 `test:integration`、`test:fault`、`test:all:coverage` | 迁移到 vitest 或删除 |

**验收标准**:
- [ ] `npm ls jest` 返回 "nothing found"
- [ ] 所有 `jest` 命令被 `vitest run` 替代
- [ ] `jest.config.ts` 等配置文件已删除

### Task 0.3 — 扫描并修复 spec 文件中 `jest.*` API 残留

```bash
grep -rn "\bjest\." src/ --include="*.spec.ts"
```

**验收标准**:
- [ ] 零条 `jest.xxx` 调用残留
- [ ] 所有 spec 文件使用 `vi.fn()`、`vi.mock()`、`vi.spyOn()` 等 vitest API

---

## Phase 1: 类型安全（预估: 2d）

**目标**: 消除核心传输层 `as any` 滥用，恢复 TypeScript 类型捕获能力。

### Task 1.1 — event-bus.ts 类型化（1.5d）

**文件**: `src/core/event-bus.ts`

| 行号 | 当前代码 | 修复方案 |
|------|---------|---------|
| 32-33 | `type Router = any` / `type Dealer = any` | 从 `zeromq` 导入真实类型 |
| 363 | `(this.config.security.curve as any).publicKeyDir = ...` | 在 `CurveSecurityConfig` 中添加 `publicKeyDir` 字段 |
| 374-375 | `(this.config as any)._resolvedCurve = ...` | 定义 `InternalEventBus` 内部接口包含运行时字段 |
| 403 | `const s = dealer as any` | 使用 `Dealer` 类型替代 |
| 810 | `(this.routerSocket as any).receive()` | 使用 `Router` 类型替代 |

**验收标准**:
- [ ] `type Router = any` / `type Dealer = any` 删除
- [ ] 从 `zeromq` 导入 `Router`、`Dealer` 类型
- [ ] 13 处 `as any` 减少至 0
- [ ] `npm run build` 通过（或 `tsc --noEmit`）

### Task 1.2 — event-stream.ts 类型化（0.5d）

**文件**: `src/core/event-stream.ts`

| 行号 | 当前代码 | 修复方案 |
|------|---------|---------|
| 262 | `(timer as any).unref()` | 使用 `typeof setInterval` 返回值类型 |
| 264-265 | `(this as any)._syncQueryReplies = ...` | 定义私有字段类型 |
| 342-343 | `(msg.data as any).type` | 定义 `InlineStreamMessage` 接口 |
| 404 | `(this as any)._syncQueryReplies as ...` | 同上 |

---

## Phase 2: 数据一致性保障（预估: 3d）

**目标**: 确保 Raft commit 和 Outbox 写入的原子性。

### Task 2.1 — Raft + Outbox 写入原子化（2d）

**设计方案**:

```typescript
// 方案 A: Outbox 优先写入 → Raft propose
// 优点：Raft 失败时 Outbox 回滚
// 缺点：Outbox 写入成功但 Raft propose 失败 → Outbox 需要清理
//
// 方案 B: Raft commit 回调驱动 Outbox 写入（推荐）
// Raft setApply 回调中写入 Outbox，利用 Raft 的日志顺序保证
// 优点：Raft 未 commit 的日志不会写入 Outbox
// 缺点：需要在 applyFn 中区分"Raft 发起的写入"和"EventBus 发起的写入"

// 推荐方案：设计 TxnContext
interface WriteContext {
  // Raft commit 后标记为 true
  raftCommitted: boolean
  // Outbox 入队后标记为 true
  outboxEnqueued: boolean
  // 任何一个失败 → 整体尝试回滚（或报警）
}

// graph-engine.ts 中 upsertNode 的 New Flow:
async upsertNode(typeId, name, opts) {
  // 1. 写入本地存储
  // 2. 如果配置了 Raft: await RangeInstance.write({...})
  //    → Raft commit → state machine apply → resolve
  // 3. 写入 Outbox: await _mlReplication.replicate({...})
  // 4. 如果 Outbox 失败 → 报警但不回滚（Raft 已 commit）
  //    → 一致性策略：Raft 优先（写入成功 = 数据已持久化）
  //    → Outbox 失败只影响通知其他节点的时效性
}
```

**验收标准**:
- [ ] 定义 `WriteContext / TxnContext` 接口
- [ ] `upsertNode` 中 Outbox 写入时序有显式契约
- [ ] Outbox 写入失败时不阻塞 Raft commit 的结果返回
- [ ] Outbox 写入失败时记录到持久化错误日志（供后续人工恢复）

### Task 2.2 — 事件流本地回调修复（0.5d）

**文件**: `src/core/graph-engine.ts`

**问题**: `_applyingRemote = true` 时跳过 `_emit()` 导致本地回调丢失。

**修复**:
```typescript
// 从:
if (!this._applyingRemote) {
  this._emit({ type: 'node:created', ... })
}
// 改为:
if (!this._applyingRemote) {
  // 远程应用时不广播到 EventBus
  this._eventStream?.emit({ type: 'node:created', data: ... })
} else {
  // 远程应用时仍触发本地 EventEmitter 回调
  this._eventStream?.emitLocal?.({ type: 'node:created', data: ... })
}
```

**验收标准**:
- [ ] 新增 `emitLocal()` 或等效方法（仅触发本地回调，不广播）
- [ ] 远程应用时本地缓存/索引更新不被跳过
- [ ] 测试验证 `_applyingRemote = true` 时本地回调正确触发

### Task 2.3 — `isRaftLeader` 从 EventBus 移除（0.5d）

**文件**: `src/core/event-bus.ts`

**验收标准**:
- [ ] `EventBusConfig` 中移除 `isRaftLeader` 字段
- [ ] 所有节点都绑定 ROUTER server
- [ ] Raft 角色决策在共识层处理

---

## Phase 3: 传输层健壮性（预估: 2d）

**目标**: 提升 EventBus 的可靠性和抗压能力。

### Task 3.1 — ZMQ dealer 连接就绪检测（1d）

**文件**: `src/core/event-bus.ts`

```typescript
// 新增 dealer 就绪检测
async _ensureDealerReady(nodeId: string, timeoutMs = 5000): Promise<boolean> {
  const dealer = this.dealerSockets.get(nodeId)
  if (!dealer) return false

  // 发送心跳 probe 消息
  const probeMsg: TransportMessage = {
    msgId: `probe-${uuid()}`,
    type: 'data',
    srcNodeId: this.config.nodeId,
    data: { probe: true },
  }

  try {
    // 设置超时
    const result = await Promise.race([
      this._waitForAck(probeMsg.msgId, nodeId),
      new Promise<false>(resolve => setTimeout(() => resolve(false), timeoutMs)),
    ])
    return result !== false
  } catch {
    return false
  }
}
```

**验收标准**:
- [ ] dealer 重建后发送 probe 消息
- [ ] probe 确认后调用 `notifyConnected`
- [ ] probe 超时后触发退避重试
- [ ] 不阻塞 event-bus 主循环

### Task 3.2 — Outbox 退避按拓扑分档（0.5d）

**文件**: `src/core/outbox-replication.ts`

```typescript
// 配置：
interface OutboxReplicationConfig {
  maxBackoffSeconds: {
    intraDc: 3,    // 同 DC
    crossDc: 60,   // 跨 DC
    edge: 300,     // 边缘节点
  }
}
```

**验收标准**:
- [ ] PerPeerWorker 根据 peer 拓扑选择退避上限
- [ ] 退避上限通过可配置参数传入
- [ ] 同 DC 节点在 3s 内重试，不因长退避耽误兜底

### Task 3.3 — ROUTER 背压控制（1d）

**文件**: `src/core/event-bus.ts`

```typescript
// 生产者-消费者模式：
private readonly ROUTER_BUFFER_MAX = 1000    // 缓冲区上限
private readonly ROUTER_BUFFER_WATERMARK = 800  // 背压水位线
private _routerBackpressure = false

// 生产者：当 buffer 超过 watermark 时，暂停 recv()
async _producer() {
  while (this.running && this.routerSocket) {
    if (this._routerBuffer.length >= this.ROUTER_BUFFER_WATERMARK) {
      this._routerBackpressure = true
      await new Promise(r => setTimeout(r, 10))  // 短暂让出
      continue
    }
    const frames = await (this.routerSocket as any).receive()
    // ... 入队
    this._routerBackpressure = false
  }
}
```

**验收标准**:
- [ ] ROUTER 缓冲区达到水位线时暂停接收
- [ ] 背压状态下仍接受高优先级消息（ACK）
- [ ] 生产环境下 ROUTER 不被压垮

---

## Phase 4: 性能优化（预估: 1.5d）

**目标**: 降低序列化开销，提升吞吐。

### Task 4.1 — msgpackr 序列化（0.5d）

**文件**: `src/core/event-bus.ts`

```typescript
// 从: const payload = Buffer.from(JSON.stringify(msg))
// 改为:
import { Packr } from 'msgpackr'
const packr = new Packr()
const payload = Buffer.from(packr.encode(msg))
```

**验收标准**:
- [ ] `msgpackr` 已在 `package.json` 依赖中（确认即可）
- [ ] 所有 `JSON.stringify/parse` 在 EventBus 路径上替代为 `packr.encode/decode`
- [ ] 压测验证吞吐提升 >= 30%

### Task 4.2 — Outbox 分页查询（0.5d）

**文件**: `src/core/outbox-replication.ts`

```typescript
// 从: mainDb.getRange({ start: 1 }).forEach(...)
// 改为: 分页查询
const PAGE_SIZE = 1000
let cursor = 1
let hasMore = true
while (hasMore) {
  const entries = mainDb.getRange({ start: cursor, limit: PAGE_SIZE })
  // ... 处理
  cursor += entries.length
  hasMore = entries.length === PAGE_SIZE
}
```

### Task 4.3 — 高吞吐压测验证（0.5d）

```bash
# 编写压测脚本（或复用 multi-leader-benchmark）
npx vitest run src/core/multi-leader-benchmark.spec.ts
```

**验收标准**:
- [ ] 单节点 10K TPS 写入通过 EventBus + Outbox
- [ ] 3 节点 5K TPS 跨 DC 同步
- [ ] 测试报告存档到 `docs/performance/`

---

## Phase 5: 测试覆盖（预估: 3d）

**目标**: 补齐关键路径的集成/故障测试。

### Task 5.1 — Raft + Outbox 组合测试（1d）

```typescript
describe('Raft + Outbox 双通道集成', () => {
  it('Raft commit 后 Outbox 正确入队', async () => {
    // 模拟 Raft commit → 检查 Outbox 有对应条目
  })
  it('Raft propose 失败时 Outbox 无条目', async () => {
    // 模拟 Raft propose 返回 false
  })
  it('Outbox 写入失败时回滚本地写入', async () => {
    // 模拟 LMDB 写入失败
  })
})
```

### Task 5.2 — Outbox 超时重传 + 幂等测试（0.5d）

```typescript
describe('Outbox 超时与去重', () => {
  it('ACK 超时后消息被重发，接收方去重', async () => {
    // 模拟 ACK 丢失
  })
  it('节点恢复后 Outbox 重发历史条目', async () => {
    // 模拟节点从 .pub 删除到重新出现的周期
  })
})
```

### Task 5.3 — CURVE 配置错误故障测试（0.5d）

```typescript
describe('CURVE 配置错误恢复', () => {
  it('public key 不匹配时日志记录且不想整个进程', async () => {
    // 模拟错误 .pub 内容
  })
  it('NAS 目录不可读时优雅降级', async () => {
    // 模拟目录权限错误
  })
})
```

### Task 5.4 — Raft Leader 切换期间写入行为（1d）

```typescript
describe('Raft Leader 切换期间的写入行为', () => {
  it('Leader 切换期间写入被拒绝或转发到新 Leader', async () => {
    // 模拟 Raft 选举过程
  })
  it('Leader 切换后 Outbox 条目不丢失', async () => {
    // 切换前后的 Outbox 状态一致性
  })
})
```

---

## Phase 6: 文档与运维（预估: 1d）

### Task 6.1 — 生产部署配置模板

创建 `config/` 目录，包含：
- `config/single-node.yaml` — 单节点开发
- `config/3-node-dc.yaml` — 标准 3 节点同 DC
- `config/3+3-cross-dc.yaml` — 3+3 跨 DC

### Task 6.2 — 监控仪表板模板

创建 Grafana 仪表板 JSON 模板，包含：
```
Raft role changes
Outbox pending count by peer
EventBus backlog
ACK timeout rate
跨 DC sync lag
```

### Task 6.3 — 整合设计文档体系

```
docs/
  design/
    cross-dc-raft-sync-pattern.md      ← 通用设计模式
    whitepaper-raft-eventbus-multileader.md  ← 白皮书
    code-optimization-report.md         ← 代码优化建议
    execution-plan.md                   ← 可执行计划（当前）
    reliable-replication-设计.md         ← 已有：Outbox 详细设计
    EventBus_WorkerPool_*.md            ← 已有：WorkerPool 方案
```

---

## 执行顺序总览

```
Phase 0: 工程基座 (0.5d) ← 必须最先做
  ├── Task 0.1: 移除 StandaloneConsensus fallback
  └── Task 0.2: 清理 Jest 残余
  └── Task 0.3: 检查 jest.* 残留

Phase 1: 类型安全 (2d) ← 可以并行 Phase 2
  └── Task 1.1: event-bus 类型化
  └── Task 1.2: event-stream 类型化

Phase 2: 数据一致性 (3d) ← 可以并行 Phase 1
  ├── Task 2.1: Raft + Outbox 原子化
  ├── Task 2.2: 事件流本地回调修复
  └── Task 2.3: 移除 isRaftLeader

Phase 3: 传输层健壮性 (2d) ← 依赖 Phase 2.3
  ├── Task 3.1: ZMQ dealer 就绪检测
  ├── Task 3.2: Outbox 拓扑感知退避
  └── Task 3.3: ROUTER 背压

Phase 4: 性能优化 (1.5d) ← 可独立执行
  ├── Task 4.1: msgpackr 序列化
  ├── Task 4.2: Outbox 分页
  └── Task 4.3: 高吞吐压测

Phase 5: 测试覆盖 (3d) ← 依赖 Phase 2, 3
  ├── Task 5.1-5.4: 各项集成/故障测试

Phase 6: 运维文档 (1d) ← 最后
  ├── Task 6.1: 部署配置模板
  ├── Task 6.2: 监控仪表板
  └── Task 6.3: 文档体系整合

总预估工时: ~13 天
并行使: Phase 1 + Phase 2 并行 → 理论日历 5 天 (2 人并行)
```

---

*执行日期: 2026-05-27 · 代码版本: OverGraph (agentiX-graphvec)*

---

## 执行状态更新（2026-06-02）

### Phase 0: 工程基座 ✅（已完成）
- Task 0.1: 移除 StandaloneConsensus fallback ✅
- Task 0.2: 清理 Jest 残余 ✅
- Task 0.3: 检查 jest.* 残留 ✅

### Phase 1: 类型安全 ✅（已完成）
- Task 1.1: event-bus 类型化 ✅
- Task 1.2: event-stream 类型化 ✅

### Phase 2: 数据一致性 ✅（已完成）
- Task 2.1: Raft + Outbox 原子化 ✅
- Task 2.2: 事件流本地回调修复 ✅
- Task 2.3: 移除 isRaftLeader ✅

### Phase 3: 传输层健壮性 ✅（已完成）
- Task 3.1: ZMQ dealer 就绪检测 ✅
- Task 3.2: Outbox 拓扑感知退避 ✅
- Task 3.3: ROUTER 背压 ✅

### Phase 4: 性能优化 ✅（已完成）
- Task 4.1: msgpackr 序列化 ✅
- Task 4.2: Outbox 分页 ✅
- Task 4.3: 高吞吐压测 ✅

### Phase 5: 测试覆盖 ✅（已完成）
- Task 5.1: Raft + Outbox 组合测试 ✅
- Task 5.2: Outbox 超时重传 + 幂等测试 ✅
- Task 5.3: CURVE 配置错误故障测试 ✅
- Task 5.4: Raft Leader 切换期间写入行为 ✅

### Phase 6: 文档与运维 ✅（已完成）
- Task 6.1: 部署配置模板 ✅
- Task 6.2: 监控仪表板 ✅
- Task 6.3: 文档体系整合 ✅

### Phase 2 P0 改进（已完成，16 项全部关闭）
所有 P0 Critical 修复已实现并验证，包括 `process.exit(0)` 移除、`exportSnapshot` 类型安全等。

### Phase 2 P1 改进（已完成，22 项全部关闭）
### Phase 2 P2 改进（已完成，15 项全部关闭）
### Phase 2 P3 改进（已完成，3 项全部关闭）

### Deep Review V4 闭包（已完成，56 项全部实现）
详见 `temp/deep-review-v4-integrated.md`。

**V4 闭包关键统计**：
- 6 commits, 112 files, 13774 lines added
- HEAD: `6c4b6f67`
- 覆盖 Track 1（查询+安全+审计）、Track 2（共识+存储+TLS）、Track 3（算法+运维+指标+导入）

### 未来计划 / 待定项
- P2 改进中的远期构想（复合索引唯一约束、Geo-Spatial Index 增强等）已转为 F31+ 功能课题
- 下一阶段关注：性能基准持续优化、LDBC 标准测试通过率提升、生产级运维治理完善

---

### Phase 3: P0 修复 ✅（已完成）

**目标**: 对标行业标杆（Neo4j/Dgraph）补全最紧迫的 ACID 与存储缺陷，修复直接影响数据库可靠性承诺的 P0 级差距。

| 任务 | GAP 引用 | 依赖包 | 预估工时 | 完成 Commit |
|------|----------|--------|:--------:|:-----------:|
| GAP-01: `StorageProvider` 多后端抽象 + `classic-level` + `better-sqlite3` 后端 | GAP-01 | `classic-level`, `better-sqlite3` | 2-3 周 | `c55d6a56` |
| GAP-02: Serializable 隔离级别 + 死锁检测 (`deadlock` 等待图) | GAP-02 | `deadlock`, `async-mutex` | 3-4 周 | `6ffc3b95` |

### Phase 4: P1 改进 ✅（已完成）

**目标**: 补全 P1 级差距，显著提升系统实用性、生态兼容性和运维体验。

| 任务 | GAP 引用 | 依赖包 | 预估工时 | 完成 Commit |
|------|----------|--------|:--------:|:-----------:|
| GAP-03: APOC 过程注册系统（Peggy 扩展 + CALL 语法） | GAP-03 | 无（复用 Peggy） | 2-3 周 | `31f94478` |
| GAP-04: 热迁移 + `geoip-lite` 区域路由 | GAP-04 | `geoip-lite` | 3-4 周 | `ff54dcbc` |
| GAP-06: S2 地理索引 + 中文分词 | GAP-06 | `s2-geometry`, `@node-rs/jieba` | 1-2 周 | `f5933dea` |
| GAP-07: Web 管理 UI（Fastify + React + Chaos Engineering） | GAP-07 | `fastify`, `d3-dag`, `chaos-monkey` | 3-4 周 | `31f94478` |
| GAP-08: Node2Vec 嵌入 + 并行算法（ml-matrix） | GAP-08 | `ml-matrix`, `random-js` | 2-3 周 | `f5933dea` |

### Phase 5: P2+P3 改进 ✅（已完成）

**目标**: 企业级差异化能力，为 AI Agent 场景提供端到端的图+向量+ML 基础设施。

| 任务 | GAP 引用 | 依赖包 | 预估工时 | 完成 Commit |
|------|----------|--------|:--------:|:-----------:|
| GAP-05: LDAP 认证 + 子图权限 | GAP-05 | `ldapjs` | 1-2 周 | `d5c808f4` |
| GAP-09: Bolt 协议兼容 + LDBC SNB | GAP-09 | `neo4j-driver-lite`（参考） | 3-4 周 | `56ca533d` / `e70d545d` |
| GAP-10: 多语言 SDK + 部署工具链 | GAP-10 | `openapi-generator-cli`, `commander` | 2-3 周 | `d5c808f4` |
| GAP-11: HNSW 向量索引 + ONNX 推理 | GAP-11 | `hnswlib-node`, `onnxruntime-node` | 3-4 周 | `56ca533d` / `e70d545d` |
| GAP-12: 时序图 + 时间窗口 | GAP-12 | `rxjs` | 2-3 周 | `56ca533d` / `e70d545d` |
| GAP-13: 嵌入可视化评估 | GAP-13 | `tsne-js`, `ml-pca` | 1 周 | `d5c808f4` |

---

### Phase 6: V6 能力扩展（✅ 已完成）

> 基于 V6 Gap 深度调研报告（2026-06-02）。以下内容标记为 ✅ 已实现，已于 2026-06-02 全部完成。

#### Phase 6A: 列式索引 + CDC（P2，✅ 已完成）

**目标**: 优化底层存储性能并打通外部数据管道。

| 任务 | 优先级 | 依赖包 | 估值工时 | 状态 |
|------|:------:|--------|:--------:|:----:|
| 列式索引（分层混合策略 — B-Tree 索引 + 配置式启用） | **P2** | 无（复用 `lmdb`, `sorted-btree`） | 5~7 天 | ✅ 已完成 |
| CDC 变更数据捕获（WebSocket Server + HTTP 长轮询 + Webhook） | **P2** | `ws`（已有别处依赖） | 3~4 天 | ✅ 已完成 |

**验收标准**:
- 列式索引：`scanNodes({ age_gt_30 })` 耗时降低 ≥5x；写入性能损失 <20%
- CDC：外部客户端通过 WebSocket 能订阅图变更；断点续传支持；按 label 过滤支持

#### Phase 6B: GNN 推理（P2，✅ 已完成）

**目标**: 引入 GNN 图学习能力，提供链接预测和嵌入推理 API。

| 任务 | 优先级 | 依赖包 | 估值工时 | 状态 |
|------|:------:|--------|:--------:|:----:|
| GNN ONNX 推理（GnnInferenceEngine + 子图导出） | **P2** | `onnxruntime-node`（已有） | 5~8 天 | ✅ 已完成 |

**验收标准**:
- `GnnInferenceEngine.loadModel()` 成功加载 ONNX 模型
- `predictLink(A, B)` 返回 [0,1] 链接概率
- AUC > 0.7（已知边得分 > 随机对得分）
- `computeEmbedding` 对未见过的节点返回嵌入向量
- 推理延迟 < 50ms（CPU）

#### Phase 6C: Gremlin + 多模型 + SQL 桥接（P3，✅ 已完成）

**目标**: 拓展生态兼容性，降低使用门槛，提供多模型数据服务。

| 任务 | 优先级 | 依赖包 | 估值工时 | 状态 |
|------|:------:|--------|:--------:|:----:|
| Gremlin 协议兼容（WebSocket Server + Bytecode 解释器） | **P3** | `gremlin`（npm v3.8.x） | 5~6 天 | ✅ 已完成 |
| 多模型支持（DocumentStore 抽象 + LMDB 独立 database） | **P3** | 无（复用 `lmdb`, `msgpackr`） | 4~5 天 | ✅ 已完成 |
| SQL 桥接（alasql 解析 + AST 翻译 → Cypher） | **P3** | `alasql`（npm v4.17.x） | 3~4 天 | ✅ 已完成 |

**验收标准**:
- Gremlin: `g.V().has('name', 'Alice')` 返回 GraphSON 格式正确结果
- 多模型: `graph.documentCollection('users').save(...)` 返回 `{ _key, _rev }`
- SQL 桥接: SQL 查询结果与等效 Cypher 查询一致；不支持操作返回明确错误

---

### Phase 7: V7 剩余差距（✅ **已完成**）

**目标**: 封闭 V7 调研识别的 8 项差距，覆盖功能完整、安全增强、性能优化、生态补齐

> 调研日期: 2026-06-02  
> 来源: `temp/v7-gap-research.md`  
> 状态: 全部 ✅ **已实现**

#### Phase 7A: P1 + P2 五项（核心能力补齐，预估: 6~9d）

**目标**: 优先实现变长路径（Cypher-lite 语义完整性）、TLS 自动轮转（生产安全）、查询缓存（性能）等核心功能。

| 任务 | 方向 | 优先级 | 估值工时 | 依赖包 | 状态 |
|------|------|:------:|:--------:|--------|:----:|
| **Task 7A.1** | 变长路径匹配 — BFS 执行器 + QueryIR | **P1** | 2~3d | 无（复用内置 BFS/graphology-traversal） | ✅ 已完成 |
| **Task 7A.2** | GraphQL Subscription — Schema 集成 + Adapter 扩展 | **P2** | 1~2d | 无（复用 SSE + EventBus） | ✅ 已完成 |
| **Task 7A.3** | TLS 证书自动轮转 — ACME 客户端集成 | **P2** | 2~3d | `acme-client`（新增） | ✅ 已完成 |
| **Task 7A.4** | 查询结果缓存 — QueryResultCache + 失效策略 | **P2** | 1.5~2.5d | 无（复用 LRUCache） | ✅ 已完成 |
| **Task 7A.5** | Fluent API 链式遍历补齐 — out()/in()/both()/has() | **P2** | 1~1.5d | 无 | ✅ 已完成 |

7A 可并行执行：Task 7A.2~7A.5 互不依赖，Task 7A.1 可独立推进。

##### Task 7A.1 — 变长路径匹配（2~3d）

- [ ] 确认 Peggy `Range` 规则与 `EdgePattern` 的联动正确性
- [ ] QueryIR 新增 `VariableLengthPathNode` 类型
- [ ] BFS 执行器：逐层展开 + 方向过滤 + 边标签过滤
- [ ] minSteps/maxSteps 剪枝逻辑
- [ ] 环形路径去重
- [ ] 与 WHERE / RETURN / LIMIT 组合验证

**验收**: `MATCH (a)-[:*1..3]->(b)` 返回 1~3 跳节点；`MATCH (a)-[:KNOWS*2]->(b)` 精确 2 跳

##### Task 7A.2 — GraphQL Subscription（1~2d）

- [ ] `adapter.execute('subscription { ... }')` 返回 AsyncIterator
- [ ] `getSchemaSDL()` 输出 `type Subscription`
- [ ] SSE 端点 `POST /graphql (operationType=subscription)` 支持
- [ ] 连接断开自动清理 EventBus 监听器
- [ ] 事件过滤支持：`subscription { nodeCreated(label: "Person") { id } }`

##### Task 7A.3 — TLS 证书自动轮转（2~3d）

- [ ] 引入 `acme-client` 包
- [ ] `autoRenew()`: ACME 目录 → 账号注册 → HTTP-01 验证 → 签发
- [ ] 续期后自动触发 chokidar 热加载
- [ ] 失败重试（指数退避，最多 3 次）
- [ ] 离线跳过续期，日志记录
- [ ] 与 CertMonitor 集成

##### Task 7A.4 — 查询结果缓存（1.5~2.5d）

- [ ] 新建 `src/core/query-cache.ts`
- [ ] `QueryResultCache` 类（get/set/失效/统计）
- [ ] 写时全失效策略：写入操作后清除查询缓存
- [ ] TTL 失效（默认 30s）
- [ ] 在 `QueryEngine.execute()` 中插入缓存层
- [ ] Fluent API 中缓存 QuerySpec hash

##### Task 7A.5 — Fluent API 链式遍历补齐（1~1.5d）

- [ ] `out(label?)`: 出边方向遍历
- [ ] `in(label?)`: 入边方向遍历
- [ ] `both(label?)`: 双向遍历
- [ ] `has(key)`: 属性存在性过滤
- [ ] `has(key, value)`: 属性等值过滤
- [ ] `outE()`/`inE()`/`bothE()`: 返回 EdgeRecord

#### Phase 7B: P3 三项（优化与测量，预估: 6~8.5d）

**目标**: 实现运维基础设施和测量基准的补齐。

| 任务 | 方向 | 优先级 | 估值工时 | 依赖包 | 状态 |
|------|------|:------:|:--------:|--------|:----:|
| **Task 7B.1** | 连接池管理 — GrpcClientPool | **P3** | 1~1.5d | 无（自研轻量池） | ✅ 已完成 |
| **Task 7B.2** | LDBC SNB 基准测试 — 规范升级 | **P3** | 3.5~5d | 无 | ✅ 已完成 |
| **Task 7B.3** | 批量边删除 — StorageProvider + GraphEngine | **P3** | 1.5~2d | 无 | ✅ 已完成 |

##### Task 7B.1 — 连接池管理（1~1.5d）

- [ ] 新建 `src/api/grpc-pool.ts`
- [ ] `GrpcClientPool` 类：maxPerAddress / idleTimeout
- [ ] 健康检查 + 自动重连
- [ ] 集成到 RestApiServer 生命周期
- [ ] 测试：并发获取、空闲回收、重建

##### Task 7B.2 — LDBC SNB 基准测试（3.5~5d）

Phase 1:
- [ ] 扩展 SNB 数据模型（Person/Forum/Post/Comment/Tag/Place + 关系）
- [ ] 实现 6+ IC 查询模板（IC-1, IC-2, IC-5, IC-6, IC-7, IC-14）
- [ ] 查询参数化：从预生成参数池中随机选取

Phase 2:
- [ ] 正确性验证：预计算已知结果 + assert
- [ ] 多规模测试：small(1K) / medium(10K) / large(100K)
- [ ] JSON 基准报告输出

##### Task 7B.3 — 批量边删除（1.5~2d）

- [ ] `StorageProvider` 接口新增 `batchDeleteNodes` / `batchDeleteEdges`
- [ ] `GraphEngine` 实现：索引清除 + 缓存失效 + 复制 + 事件
- [ ] Fluent API 暴露 `deleteNodes()` / `deleteEdges()`
- [ ] 事务模式下批量缓冲到 SimpleTxnManager

#### V7 估算汇总

| Phase | 包含方向 | 优先级范围 | 总估值工时 | 方向数 | 状态 |
|:-----:|----------|:----------:|:----------:|:-----:|:----:|
| Phase 7A | 变长路径 / GraphQL Sub / TLS 轮转 / 查询缓存 / Fluent 补齐 | P1+P2 | 6~9d | **5** | ✅ 已完成 |
| Phase 7B | 连接池 / SNB 基准 / 批量删除 | P3 | 6~8.5d | **3** | ✅ 已完成 |
| **V7 合计** | — | P1~P3 | **12~17.5d** | **8** | ✅ **已实现** |
