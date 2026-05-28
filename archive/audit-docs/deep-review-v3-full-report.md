# AgentiX GraphVec 深度审查 V3 — 全量报告

**日期**: 2026-05-26  
**方法**: 5 路子 Agent 并行审查（源码审计 × 4 + 联网竞品基准 × 1）  
**总代码量**: ~22K 生产代码 + ~16K 测试代码（73 个测试文件）

---

## 总体统计

| 审查维度 | 文件数 | 发现数 | P0 | P1 | P2 | P3 |
|---------|:-----:|:------:|:--:|:--:|:--:|:--:|
| 存储核心层 | 13 | 11 | 2 | 3 | 4 | 2 |
| 共识+分片层 | 13 | 13 | 3 | 5 | 5 | 0 |
| 查询+API+运维层 | 18 | 18 | 1 | 4 | 6 | 7 |
| 横切安全+性能 | 全量 | 18 | 2 | 4 | 12 | 0 |
| 竞品联网对比 | 15产品 | — | — | — | — | — |
| **合计** | **44+** | **60** | **8** | **16** | **27** | **9** |

---

## 一、P0 紧急（8 项）— 详细分析

---

### 1. upsertNode 递归死循环 (P0, core/graph-engine.ts:262)

#### 1.1 问题是什么

**文件**: `src/core/graph-engine.ts`，第 262 行附近  

**代码模式**:

```typescript
// 伪代码示意
class GraphEngine {
  open() {
    // 注册 applyHandler: 在 EventStream 收到远程数据时被调用
    this.eventStream.on('remote-data', (data) => {
      this.upsertNode(data.node);
    });
  }

  upsertNode(node: Node) {
    // ... 业务逻辑 ...
    this._emit('node-upserted', node); // emit 事件
  }
}
```

**问题本质**:  
- `open()` 注册的 `applyHandler` 调用 `upsertNode()`  
- `upsertNode()` 内部 `_emit` 事件（如 `node-upserted`）  
- 该事件如果被 EventStream 的 `_onRemoteData` 再次捕获并触发 `applyHandler`，形成无限递归  
- 最终导致 **栈溢出（Stack Overflow）**，进程崩溃  

**触发场景**: 多节点复制场景下，节点 A 更新数据 → 同步到节点 B → B 的 applyHandler 调用 upsertNode → _emit 事件 → 事件被同一个 EventStream 监听器捕获 → 回环  
**影响范围**: 任何多节点部署（≥2 节点）都可能触发。破坏程度：**致命（P0）**。

#### 1.2 如何解决

**修改文件**: `src/core/graph-engine.ts`、`src/core/event-stream.ts`

**实现思路**:
- 在 `GraphEngine` 中添加 `_applyingRemote` 标志位 + 递归深度计数器
- `applyHandler` 执行前设置 `_applyingRemote = true`
- `upsertNode()` / `upsertEdge()` 在 `_emit` 前检查标志位，跳过 emit
- 递归深度超过 10 时抛出异常

```typescript
private _recursionDepth = 0;
private readonly MAX_RECURSION_DEPTH = 10;

upsertNode(node: Node): void {
  this._recursionDepth++;
  if (this._recursionDepth > this.MAX_RECURSION_DEPTH) {
    this._recursionDepth = 0;
    throw new Error('Recursion depth exceeded in upsertNode');
  }
  try {
    if (!this._applyingRemote) {
      this._emit('node-upserted', node);
    }
  } finally {
    this._recursionDepth--;
  }
}
```

**修改量**: ~30 行 | **接口变更**: 无

#### 1.3 npm 包研究与选择

无需引入新 npm 包。纯代码逻辑修复。

#### 1.4 是否需要自研

无需自研。

**推荐方案**: 在 `GraphEngine` 中添加递归深度计数器 + `_applyingRemote` 标志位，限制最大递归深度为 10。

#### 1.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-1.1 | 正常 upsertNode | 单节点创建 100 个 node | 全部成功 | 基本功能 |
| TC-1.2 | 递归触发保护 | 构造 applyHandler → upsertNode → _emit 回环条件 | 第 11 次递归时抛出错误，进程不崩溃 | 异常路径 |
| TC-1.3 | 远程复制场景 | 2 节点集群，节点 A upsert 1000 个 node | 节点 B 正常接收，无栈溢出 | 并发 |
| TC-1.4 | 恢复后继续工作 | 触发递归保护后再次调用 upsertNode（不触发回环） | 正常处理，计数器已重置 | 边界条件 |
| TC-1.5 | 性能退化 | 单节点批量 upsert 10K 节点 | 性能退化 ≤2% | 性能 |

---

### 2. EventStream ACK前dedup永久丢失 (P0, core/event-stream.ts:358)

#### 2.1 问题是什么

**文件**: `src/core/event-stream.ts`，第 358 行附近

```typescript
async handleData(raw: Message): Promise<void> {
  this.dedup.add(raw.msgId);  // 在 applyHandler 前标记去重
  try {
    await this.applyHandler(raw);
    this.ack(raw.msgId);
  } catch (err) {
    this.nack(raw.msgId);
    // ❌ 没有 this.dedup.remove(raw.msgId) → 同一 msgId 重试被拦截 → 永久丢失
  }
}
```

**问题本质**: `dedup.add()` 在 `applyHandler` 执行前加入去重集合。`applyHandler` 抛异常后，dedup 条目不被移除。发送方收到 NACK 后重试同一 msgId，被 dedup 拦截 → **永久丢失**。

**影响范围**: 所有复制场景。任何一次临时故障后数据永久丢失。**致命（P0）**。

#### 2.2 如何解决

**修改文件**: `src/core/event-stream.ts`

**实现思路**: catch 分支添加 `this.dedup.remove(raw.msgId)` + 指数退避重试机制

```typescript
async handleData(raw: Message, retries = 3): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      this.dedup.add(raw.msgId);
      await this.applyHandler(raw);
      this.ack(raw.msgId);
      return;
    } catch (err) {
      if (attempt < retries) {
        await sleep(100 * Math.pow(2, attempt - 1));
        continue;
      }
      this.dedup.remove(raw.msgId);
      this.nack(raw.msgId);
      logger.error(`Message ${raw.msgId} failed after ${retries} retries`);
    }
  }
}
```

**修改量**: ~20 行 | **接口变更**: 无

#### 2.3 npm 包研究与选择

无需引入新 npm 包。

#### 2.4 是否需要自研

无需自研。

**推荐方案**: catch 分支添加 `this.dedup.remove(raw.msgId)` + 指数退避重试（最多 3 次）。

#### 2.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-2.1 | 正常 ACK 路径 | applyHandler 成功执行 | 正常 ACK | 基本功能 |
| TC-2.2 | 一次失败后重试成功 | 注入第一次抛异常，第二次成功 | ACK，无 NACK | 异常路径 |
| TC-2.3 | 全部失败 | 持续抛异常 4 次 | dedup 被移除，NACK 发送，重试可被重新接收 | 异常路径 |
| TC-2.4 | 重试消息恢复 | applyHandler 失败 → NACK → 发送方重试 | 接收方处理重试消息（不被 dedup 拦截） | 边界条件 |
| TC-2.5 | 并发消息 | 10 个 msgId 同时处理，其中一个失败 | 其他消息不受影响 | 并发 |

---

### 3. TcpTransport sendTo无ACK (P0, consensus/raft-logic-consensus.ts:113)

#### 3.1 问题是什么

**文件**: `src/consensus/raft-logic-consensus.ts`，第 113 行附近

```typescript
async sendTo(peer: string, msg: RaftMessage): Promise<void> {
  try {
    const socket = this.transport.get(peer);
    socket.write(serialize(msg));
    // ❌ 无 ACK 等待 → 丢包静默忽略
  } catch (err) {
    logger.warn(`sendTo failed: ${err}`);
    // ❌ 不重试
  }
}
```

**问题本质**: TCP socket write 后立即 resolve，不等待 ACK。Raft 选举投票、心跳响应、append-entries 响应在 TCP 丢包后直接丢失，导致集群行为不可预测。

**影响范围**: 整个 Raft 共识层。投票丢失 → 选举失败 → 集群不可用。数据复制丢失。**致命（P0）**。

#### 3.2 如何解决

**修改文件**: `src/consensus/raft-logic-consensus.ts`、`src/transport/transport.ts`

**实现思路**: 有界发送缓冲区 + writeTimeout + 最多 3 次重试 + 失败计数器

```typescript
private readonly MAX_BUFFER = 1024;
private readonly WRITE_TIMEOUT = 5000;
private readonly MAX_RETRIES = 3;

async sendTo(peer: string, msg: RaftMessage): Promise<void> {
  if (this._sendBuffer.size >= this.MAX_BUFFER) {
    logger.error(`Send buffer full: ${peer}`);
    return;
  }
  for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
    try {
      const socket = this.transport.get(peer);
      await this._writeWithTimeout(socket, serialize(msg), this.WRITE_TIMEOUT);
      return;
    } catch (err) {
      if (attempt < this.MAX_RETRIES - 1) await sleep(100 * Math.pow(2, attempt));
    }
  }
  throw new Error(`sendTo ${peer} failed after ${this.MAX_RETRIES} attempts`);
}
```

**修改量**: ~80 行 | **接口变更**: 无

#### 3.3 npm 包研究与选择

无需引入新 npm 包。使用 Node.js 内置 `net` 模块的 `socket.write()` callback 即可实现 ACK 确认。

#### 3.4 是否需要自研

无需自研。

**推荐方案**: 有界发送缓冲区 + writeTimeout + 最多 3 次指数退避重试 + 失败计数器。

#### 3.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-3.1 | 正常发送 | 3 节点集群 Leader 发送心跳 | 正常送达 | 基本功能 |
| TC-3.2 | 网络闪断 | iptables 模拟 2s 断开再恢复 | 重试后成功发送 | 异常路径 |
| TC-3.3 | 永久断开 | 切断 Follower 网络，连续发送 10 条 | 全部失败后计数器正确记录 | 异常路径 |
| TC-3.4 | 缓冲满 | MAX_BUFFER=5，快速发 10 条到断连连节点 | 第 6 条起记录 buffer_full | 边界条件 |
| TC-3.5 | 长稳 | 3 节点集群运行 1 小时，间歇性注入 500ms 延迟 | 集群稳定，不触发非必要选举 | 性能 |
| TC-3.6 | 并发 | 10 个发送同时到不同 peer | 全部有序完成 | 并发 |

---

### 4. 双写非事务 (P0, shard/shard-manager.ts:83)

#### 4.1 问题是什么

**文件**: `src/shard/shard-manager.ts`，第 83 行附近

```typescript
async _writeWithDualWrite(data: WriteRequest): Promise<void> {
  await this._writeToPrimary(data);
  try {
    await this._writeToSecondary(data);
  } catch (err) {
    // ❌ 静默 catch → 源成功目标失败 → 数据永久不一致
  }
}

batchUpsertEdges(edges: Edge[]): void {
  // ❌ 甚至没有双写逻辑
}
```

**问题本质**: 双写目标失败静默 catch，不重试不报警。`batchUpsertEdges` 没有双写逻辑。分片迁移时数据不一致。

**影响范围**: 分片分裂/合并时的数据一致性。**致命（P0）**。

#### 4.2 如何解决

**修改文件**: `src/shard/shard-manager.ts`

**实现思路**: 目标写入失败重试 3 次（指数退避）+ batchUpsertEdges 补全双写 + 异步 checksum 校验

**修改量**: ~60 行 | **接口变更**: 无（但可能抛出新异常 → 调用方需处理）

#### 4.3 npm 包研究与选择

无需引入新 npm 包。checksum 用 `crypto.createHash('sha256')`（内置）。

#### 4.4 是否需要自研

无需自研。

**推荐方案**: 目标写入 3 次指数退避重试 + batchUpsertEdges 补全双写 + 异步 checksum 校验。

#### 4.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-4.1 | 正常双写 | 分片分裂中写入 100 条 | 源目标一致 | 基本功能 |
| TC-4.2 | 目标临时失败 | 目标 500ms 延迟 | 重试后第二次成功 | 异常路径 |
| TC-4.3 | 目标永久失败 | 目标永久不可用 | 3 次重试后抛出异常 | 异常路径 |
| TC-4.4 | batchUpsertEdges 双写 | 插入 1000 条 edge | 源目标均写入 | 基本功能 |
| TC-4.5 | checksum 校验 | 双写后校验 | checksum 一致 | 基本功能 |

---

### 5. BFS非一致遍历 (P0, shard/shard-manager.ts:418)

#### 5.1 问题是什么

**文件**: `src/shard/shard-manager.ts`，第 418 行

**问题本质**: 每次 `this.neighbors(nodeId)` 读取当前最新快照。第 1 层是 T0 时刻、第 2 层是 T1 时刻（中间有写入），导致拓扑不一致 → 结果不可靠。

**影响范围**: PPR 等图分析返回不可信结果。**致命（P0）**。

#### 5.2 如何解决

**修改文件**: `src/shard/shard-manager.ts`

**实现思路**: BFS 开始时快照整个邻接表到内存 Map，后续遍历在内存中完成。

```typescript
async bfs(startNodeId: string, maxDepth: number): Promise<Node[]> {
  const snapshot = await this._snapshotAdjacencyList();
  // 在内存快照中遍历，不实时查询
}
```

**修改量**: ~50 行 | **接口变更**: 无

#### 5.3 npm 包研究与选择

无需引入新 npm 包。使用 ES6 Map。

#### 5.4 是否需要自研

无需自研。

**推荐方案**: BFS 开始时快照整个邻接表到内存 Map。

#### 5.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-5.1 | 静态图 BFS | 空转图 BFS 深度 3 | 一致结果 | 基本功能 |
| TC-5.2 | 写入中的 BFS | BFS 运行时持续插入 | 基于快照时刻的拓扑 | 并发 |
| TC-5.3 | 大图 | 10K 节点图深度 10 | <2s 完成 | 性能 |
| TC-5.4 | 空图 | 空图运行 BFS | 返回 `[]` | 边界 |
| TC-5.5 | 深度 0 | 深度 0 BFS | 只返回起始节点 | 边界 |
| TC-5.6 | 可复现 | 连续 3 次无写入 BFS | 结果完全相同 | 基本功能 |

---

### 6. health.ts 编译错误 (P0, ops/health.ts:85)

#### 6.1 问题是什么

**文件**: `src/ops/health.ts:85`

```typescript
const result = await await this._checkEngine();  // ❌ 双 await
```

#### 6.2 如何解决

删除多余 `await`：

```typescript
const result = await this._checkEngine();
```

**修改量**: 1 行

#### 6.3 npm 包研究与选择

无需引入。

#### 6.4 是否需要自研

无需自研。

**推荐方案**: 删除多余 `await`。

#### 6.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-6.1 | 编译通过 | `npm run build` | 无 await 相关错误 | 基本功能 |
| TC-6.2 | health check | GET /health | 返回 200 | 基本功能 |

---

### 7. bodySizeLimit绕过 (P0, 横切安全)

#### 7.1 问题是什么

**涉及文件**: HTTP body 解析相关 handler（约 3-4 个文件）

```typescript
async handleRequest(req, res): Promise<void> {
  if (contentLength > limit) {
    res.statusCode = 413;
    res.end('Too Large');
    // ❌ 没有 return → 继续 parseBody()
  }
  const body = await this.parseBody(req);  // OOM 风险
}
```

**问题本质**: 返回 413 后未 return，继续解析 body。chunked transfer 可绕过 Content-Length 检查。

**影响范围**: OOM 攻击。**致命（P0）**。

#### 7.2 如何解决

**修改文件**: 相关 HTTP handler（约 3-4 个文件）

```typescript
async handleRequest(req, res): Promise<void> {
  if (contentLength > limit) {
    res.statusCode = 413;
    res.end('Too Large');
    return;  // 关键修复
  }
  // chunked transfer 实时计数
  let total = 0;
  req.on('data', (chunk) => {
    total += chunk.length;
    if (total > limit) req.destroy();
  });
  const body = await this.parseBody(req);
}
```

**修改量**: ~30 行 | **接口变更**: 无

#### 7.3 npm 包研究与选择

| 候选 | 大小 | 纯嵌入 | 许可 | 推荐 |
|------|:----:|:------:|:----:|:----:|
| 原生 Node.js 实现 | 0 | ✅ | — | ✅ |
| `body-parser` | ~50KB | ✅ | MIT | ⚠️ 需引入框架 |
| `raw-body` | ~30KB | ✅ | MIT | ⚠️ 多余依赖 |

使用原生实现。

#### 7.4 是否需要自研

无需自研。使用原生 Node.js API 即可。

**推荐方案**: 413 后 `return` + chunked transfer 实时计数 + 超量 `req.destroy()`。

#### 7.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-7.1 | 正常请求 | 发送 limit 内请求 | 200 | 基本功能 |
| TC-7.2 | Content-Length 超限 | 发送 > limit 的请求 | 413，不执行后续 | 基本功能 |
| TC-7.3 | chunked 超限 | 发送 > limit 的 chunked body | 连接断开 | 安全 |
| TC-7.4 | 2GB 超大 body | 发送 2GB chunked body | 内存增长不超过 limit | 安全 |
| TC-7.5 | 正常请求不受影响 | limit=1MB，发 512KB | 正常处理 | 边界 |

---

### 8. package-lock无校验 (P0, 横切安全)

#### 8.1 问题是什么

**文件**: `package.json`、`package-lock.json`

- `package.json` 中依赖使用 `^` range（如 `^1.2.3`），允许自动升级 minor/patch
- `raft-logic` WASM 无签名验证，攻击者可中间人替换
- `package-lock.json` 存在但 semver range 允许自动升级

**影响范围**: 供应链攻击风险。**致命（P0）**。

#### 8.2 如何解决

**修改文件**: `package.json`

```json
{
  "dependencies": {
    "better-sqlite3": "11.7.0",  // 去掉 ^
    "raft-logic": "0.3.14"       // 去掉 ^
  }
}
```

同时：
- 在 `package-lock.json` 中添加 integrity hash 验证（npm 自动管理）
- 添加 `scripts` 中的 `preinstall` hook 校验 integrity

**修改量**: ~10 行 | **接口变更**: 无

#### 8.3 npm 包研究与选择

| 候选 | 说明 | 推荐 |
|------|------|:----:|
| npm integrity 机制 | 内置，lockfile 中的 `integrity` 字段 | ✅ |
| `lockfile-lint` | 校验 lockfile 完整性 | ⚠️ 额外依赖 |
| npm audit | 安全检查 | ⚠️ 不防供应链 |

推荐直接使用 npm 内置的 integrity 机制。

#### 8.4 是否需要自研

无需自研。使用 npm 内置机制。

**推荐方案**: 锁定精确版本号（去掉 `^`）+ npm integrity hash + CI 中执行 `npm ci`（校验 integrity）。

#### 8.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-8.1 | 锁定版本 | 检查 package.json 中所有依赖已去掉 `^` | 无 semver range | 基本功能 |
| TC-8.2 | integrity 校验 | `npm ci` 安装依赖 | 正常通过 | 基本功能 |
| TC-8.3 | 篡改检测 | 手动修改 node_modules 中某个文件后运行 | `npm ci` 恢复正确版本 | 安全 |
| TC-8.4 | CI 一致性 | CI 流水线中运行 `npm ci` | lockfile 一致 | 基本功能 |

---

## 二、P1 严重（8 项）— 详细分析

---

### 9. SSE连接泄漏 + metrics无认证 (P1)

#### 9.1 问题是什么

**文件**: `src/rest.ts`（SSE endpoint、/metrics endpoint）

**SSE 连接泄漏**:
```typescript
// 伪代码示意
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  // ❌ 未注册 req.on('close') 清理回调
  // 客户端断开后 res 对象泄漏
  this._sseClients.add(res);  // 引用永久保留
});
```

**问题本质**: 
- SSE endpoint 在客户端连接建立后注册到 `_sseClients`，但没有监听 `req.on('close')` 事件来清理
- 客户端断开后，`res` 对象的引用仍然在 `_sseClients` 集合中
- 累积的泄漏导致内存持续增长，最终 OOM
- 每个泄漏的 `res` 对象还持有底层的 socket、buffer 等 → 每个约 4-8KB

**/metrics 无认证**:
```typescript
app.get('/metrics', async (req, res) => {
  const metrics = await this.collectMetrics();
  // ❌ 无任何认证检查！任何人都可访问
  res.json(metrics);
});
```

**问题本质**:
- `/metrics` 端点返回性能指标、标签、请求路径等敏感信息
- 无任何认证 → 攻击者可监控系统状态、发现性能瓶颈、分析流量模式
- 在生产环境是严重的信息泄露

**影响范围**: SSE 连接泄漏影响长期运行的 Node 进程稳定性。metrics 无认证影响生产安全。

#### 9.2 如何解决

**修改文件**: `src/rest.ts`

**SSE 修复**:
```typescript
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  this._sseClients.add(res);
  
  req.on('close', () => {
    this._sseClients.delete(res);
    logger.info(`SSE client disconnected, active: ${this._sseClients.size}`);
  });
  
  req.on('error', (err) => {
    this._sseClients.delete(res);
    logger.error(`SSE client error: ${err}`);
  });
});
```

**Metrics 修复**:
```typescript
app.get('/metrics', authenticate, async (req, res) => {
  const metrics = await this.collectMetrics();
  res.json(metrics);
});

function authenticate(req, res, next): void {
  // 使用已有的 auth 中间件或 API key 验证
  const token = req.headers['authorization'];
  if (!token || !validateToken(token)) {
    res.statusCode = 401;
    res.json({ error: 'Unauthorized' });
    return;
  }
  next();
}
```

**修改量**: ~50 行 | **接口变更**: `/metrics` 需要认证（破坏性变更，需文档化）

#### 9.3 npm 包研究与选择

无需引入新 npm 包。认证复用项目中已有的 auth 中间件即可。

#### 9.4 是否需要自研

无需自研。

**推荐方案**: SSE 添加 `req.on('close')` 清理 + `/metrics` 添加已有 auth middleware。

#### 9.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-9.1 | SSE 正常连接 | 连接 /events | 正常接收事件流 | 基本功能 |
| TC-9.2 | SSE 断开清理 | 连接后断开，检查 `_sseClients.size` | 断开后减少 1 | 基本功能 |
| TC-9.3 | SSE 多次连接断开 | 重复连接/断开 1000 次 | 无泄漏（`_sseClients.size` 最终为 0） | 性能 |
| TC-9.4 | SSE 连接异常 | SSE 连接时模拟 socket error | 清理引用 | 异常路径 |
| TC-9.5 | metrics 有认证 | 携带有效 token 访问 /metrics | 返回 200 + 数据 | 基本功能 |
| TC-9.6 | metrics 无认证 | 不携带 token 访问 /metrics | 返回 401 | 安全 |
| TC-9.7 | metrics 无效 token | 携带错误 token | 返回 401 | 安全 |
| TC-9.8 | 向后兼容 | 检查已有 client 是否传递 token | 文档标注 breaking change | 向后兼容 |

---

### 10. Cypher-lite注入防护 (P1)

#### 10.1 问题是什么

**文件**: 查询语言解析层（peggy 生成的 parser）

```typescript
// 伪代码示意
function executeCypher(query: string, params: Record<string, any>): Result {
  const ast = parser.parse(query);
  // ❌ params 直接在字符串拼接中使用，无深度限制、无联合查询限制
  // ❌ 无 query timeout
  const result = this.executePlan(buildPlan(ast, params));
  return result;
}
```

**问题本质**:
- Cypher-lite 查询无深度/联合限制（无 max depth、max join）
- 攻击者可构造递归/笛卡尔积查询导致资源耗尽
- params 中的恶意构造（如超大数组、嵌套对象）可能导致解析器崩溃
- 缺少沙箱机制

**影响范围**: 拒绝服务攻击。所有公开的查询 endpoint。

#### 10.2 如何解决

**修改文件**: 查询执行层相关文件

**实现思路**:
- 添加查询深度限制（默认 maxDepth=50）
- 添加联合（join）数量限制（默认 maxJoins=10）
- 添加 query timeout（默认 30s）
- 参数深度限制（max 3 层嵌套）
- 参数大小限制（max 1MB）

```typescript
interface QueryLimits {
  maxDepth: number;    // 默认 50
  maxJoins: number;    // 默认 10
  timeoutMs: number;   // 默认 30000
  maxParamSize: number; // 默认 1MB
}

async executeQuery(query: string, params: Record<string, any>, limits?: QueryLimits): Promise<Result> {
  const config = { ...defaultLimits, ...limits };
  
  // 参数大小检查
  const paramSize = JSON.stringify(params).length;
  if (paramSize > config.maxParamSize) {
    throw new Error(`Query parameters exceed max size of ${config.maxParamSize}`);
  }
  
  // 超时控制
  const result = await withTimeout(
    this._executeWithLimits(query, params, config),
    config.timeoutMs
  );
  return result;
}
```

**修改量**: ~80 行 | **接口变更**: 可能新增 `QueryLimits` 参数

#### 10.3 npm 包研究与选择

无需引入新 npm 包。纯代码实现。

#### 10.4 是否需要自研

无需自研。限流/超时是通用模式。

**推荐方案**: 查询深度限制 + join 限制 + query timeout + 参数大小检查。

#### 10.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-10.1 | 正常查询 | 简单 MATCH 查询 | 正常执行 | 基本功能 |
| TC-10.2 | 深度超限 | 构造深度 100 的查询 | 被拒绝 | 安全 |
| TC-10.3 | 超时 | 构造一个延迟很高的查询 | 30s 后超时报错 | 安全 |
| TC-10.4 | 超大参数 | 传递 5MB 的 params | 被拒绝 | 安全 |
| TC-10.5 | 正常复杂查询 | 深度 10、join 5 的查询 | 正常执行 | 边界 |
| TC-10.6 | 配置化 | 通过 config 调整 maxDepth | 修改后立即生效 | 向后兼容 |

---

### 11. ZMQ CURVE认证启用 (P1)

#### 11.1 问题是什么

**文件**: `src/core/event-bus.ts`

`_applyCurveToSocket()` 方法中有一段 guard：
```
if (!curve || curve.mode !== 'explicit') return
```
ROUTER 端（`_applyCurveToSocket(this.routerSocket, true)`）和 DEALER 端（`_connectDealerByPubFile` / `_connectMissingDealers` / `_reconnectDealer`）都是同样的条件判断。当 `curve.mode` 不是 `'explicit'` 时，socket 的 `curveServer`、`curveSecretKey`、`curvePublicKey` 等属性**全部不设置**。

源码中定义了 `CurveKeyMode = 'explicit' | 'nas'` 两种模式。NAS 模式在 `start()` 中经过 `resolveCurveConfig` 转换为 explicit 配置后覆盖 `this.config.security.curve`，实际能走通 CURVE。但如果调用方配置了 nas 模式但没有走完这个转换（或测试代码直接构造 EventBus 传了原始 nas config），CURVE 就是摆设。

**问题本质**: 认证路径依赖 `mode === 'explicit'` 这个中间态，不是**无条件强制**。任何导致转换不完整或跳过转换的路径都让 ZMQ 通信处于明文状态。

**影响范围**: CURVE 认证不是强制机制，存在未加密路径。集群内节点间消息可能明文传输。

#### 11.2 如何解决

**修改文件**: `src/core/event-bus.ts`

**原则**: CURVE 强制启用，不可关闭，但配置项仍需保留（port、publicKeyDir、server 等）。

**思路**: 删除 `mode` 字段和 `CurveExplicitConfig`/`CurveNasConfig` 的 union 类型，合并为单一的 `CurveSecurityConfig`。所有 `if (curve?.mode === 'explicit')` 检查删除，CURVE 配置无条件应用到所有 socket。配置中不再有「启用与否」的概念。

需要的配置项（必须提供）：
- `port: number` — 本节点 ROUTER 监听端口
- `server: boolean` — 是否作为 CURVE server
- `publicKeyDir: string` — NAS 共享公钥目录路径

不需要的配置项（删除）：
- 任何 enable/disable 开关
- `mode: 'explicit' | 'nas'` 字段 — CURVE 永远是 full 模式

需改动的点：
1. 删除 `CurveKeyMode`、`CurveExplicitConfig`、`CurveNasConfig`、`CurveConfig` 类型定义
2. 新建 `CurveSecurityConfig { port, server, publicKeyDir }`（用户配置）和 `ResolvedCurveConfig { server, secretKey, publicKey, peerKeys, port, publicKeyDir }`（运行时配置）
3. `EventBusConfig.security` 改为 `EventBusConfig.curve`，类型为 `CurveSecurityConfig`（非可选）
4. `_applyCurveToSocket`：删除 `if (!curve || curve.mode !== 'explicit') return`，直接设 socket 属性
5. `_connectDealerByPubFile`：删除 `if (curve?.mode === 'explicit')`，无条件设 CURVE 属性
6. `_connectMissingDealers`：删除 `if (curve?.mode === 'explicit' && curve.peerKeys)`，无条件设
7. `_reconnectDealer`：同上，两处 mode 检查都删除
8. `start()` 中 NAS 转换路径：不再需要 `resolveCurveConfig` 返回 `explicitConfig`，直接生成密钥对+写 pub 文件+扫 peers
9. 新增 `_curveConfig: ResolvedCurveConfig` 实例字段
10. 所有引用 `this.config.security?.curve` 的地方改为 `this._curveConfig`
11. `start()` 中原来的 `hasZMQ && !this.config.security?.curve → throw` 改为 `if (!this.config.curve) throw`（curve 是必填，但由 TS 类型保障，optional check 作为防御式编程）

**修改量**: ~100 行改动（类型定义+条件删除+重命名） | **接口变更**: 是——`EventBusConfig.security` → `EventBusConfig.curve`，类型改为非可选 `CurveSecurityConfig`

#### 11.3 npm 包研究与选择

无需引入新 npm 包。使用 zmq 内置的 CURVE (Curve25519) 机制，`zmq.curveKeyPair()` 来自 `zeromq` 库本身。

#### 11.4 是否需要自研

无需自研。Curve25519 是 ZeroMQ 内置能力，Z85 编码的公钥交换协议也是 zmq 内置支持。

**推荐方案**: 删除 `mode` 字段、删除 union 类型、删除所有 `mode === 'explicit'` 条件判断，CURVE 强制应用于所有 ZMQ socket。

#### 11.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-11.1 | CURVE 强制启用 | 传入曲线配置（port/server/publicKeyDir），启动 2 节点集群 | CURVE 认证生效，通信正常 | 基本功能 |
| TC-11.2 | 密钥不匹配 | 两个节点用不同密钥目录 | 双方认证失败，socket 断开或消息被拒收 | 安全 |
| TC-11.3 | ROUTER 加密验证 | ROUTER socket 上是否设置了 curveServer/curveSecretKey/curvePublicKey | 三个属性均存在且非空 | 基本功能 |
| TC-11.4 | DEALER 加密验证 | DEALER socket 上是否设置了 curvePublicKey/curveSecretKey/curveServerKey | 三个属性均存在且非空 | 基本功能 |
| TC-11.5 | 缺少曲线配置 | 不传入 curve 配置启动 EventBus（TS 非可选，但防御式检查应该抛） | 抛出明确异常，提示 curve 配置必须提供 | 异常路径 |
| TC-11.6 | NAS 目录自动发现 | A 节点启动后写入 .pub，B 节点启动后扫到 A 的 .pub | 双方 DEALER 均成功连接且 CURVE 加密生效 | 基本功能 |
| TC-11.7 | 密钥变更重连 | 节点 A 公钥变化，B 检测到后使用新密钥重建 DEALER | B 用新密钥连接 A 成功 | 边界 |

---

### 12. TLS加密传输层 (P1)

#### 12.1 问题是什么

**文件**: `src/transport/transport.ts`

**问题本质**: 所有 Raft/ZMQ 消息在节点间明文传输。无 TLS 加密。在使用 CURVE 认证的同时，传输层本身也需要加密。

**影响范围**: 跨网络部署时的数据泄露风险。在有 CURVE 认证但无 TLS 加密的情况下，攻击者可以嗅探节点间传输的数据内容。

#### 12.2 如何解决

**修改文件**: `src/transport/transport.ts`

**实现思路**: 添加 TLS 支持（`tls.createServer` / `tls.connect`），通过 config 控制是否启用。

```typescript
function createTLSServer(options: TLSOptions): tls.Server {
  return tls.createServer({
    key: fs.readFileSync(options.keyPath),
    cert: fs.readFileSync(options.certPath),
    ca: options.caPath ? fs.readFileSync(options.caPath) : undefined,
    requestCert: true,  // mTLS 支持
    rejectUnauthorized: true,
  });
}
```

**配置示例**:
```json
{
  "tls": {
    "enabled": true,
    "keyPath": "/etc/agentiX/certs/server.key",
    "certPath": "/etc/agentiX/certs/server.crt",
    "caPath": "/etc/agentiX/certs/ca.crt"
  }
}
```

**修改量**: ~80 行（transport.ts + config 解析） | **接口变更**: config 新增 `tls.*` 字段

#### 12.3 npm 包研究与选择

使用 Node.js 内置 `tls` 模块。无需引入外部包。

#### 12.4 是否需要自研

无需自研。Node.js 内置 TLS 模块已完成所有繁重工作，只需包装配置。

**推荐方案**: 使用 Node.js 内置 `tls` 模块 + config 驱动。支持 mTLS。

#### 12.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-12.1 | TLS 非启用 | tls.enabled=false | 默认明文连接 | 基本功能 |
| TC-12.2 | TLS 正常启用 | 配置 tls.enabled=true + 合法证书密钥 | 节点间 TLS 加密通信，连接正常 | 基本功能 |
| TC-12.3 | 证书过期 | 使用过期证书 | 连接失败，返回 TLS 错误信息 | 异常路径 |
| TC-12.4 | 密钥不匹配 | 使用不匹配的 cert/key 对 | 服务无法启动 | 异常路径 |
| TC-12.5 | mTLS 双向认证 | 配置 ca + requestCert | 客户端需提供合法证书 | 安全 |
| TC-12.6 | 性能退化 | 对比 TLS 与非 TLS 的吞吐（1000 次 Raft 消息） | 退化 <= 15% | 性能 |
| TC-12.7 | 向后兼容 | 不配置 tls 字段（config 不存在） | 无 TLS（默认行为不变） | 向后兼容 |
| TC-12.8 | 混合模式 | 一个节点启用 TLS，一个节点不启用 | 连接失败，报错提示不兼容 | 安全 |

## 六、Phase B 扩展 — 剩余 P1 修复 4 项

---

### 13. deleteNode级联删除 (P1, shard/shard-manager.ts)

#### 13.1 问题是什么

**文件**: `src/shard/shard-manager.ts:331`

**代码模式**:

```typescript
async deleteNode(nodeId: string): Promise<void> {
  await this._storage.deleteNode(nodeId);
  // ❌ 未删除关联的边 → 产生孤儿边
  // ❌ 未清理 event-stream 中的缓存
}
```

**问题本质**: 
- 删除节点后，关联该节点的边仍然存在于存储中
- 后续查询这些边会引用不存在的节点（返回 null/undefined）
- 如果运行图分析（如遍历、PPR），孤儿边导致分析结果不一致或崩溃

**触发场景**: 任何 deleteNode 操作。如果节点有出度/入度，关联边永久残留。

**影响范围**: 图数据完整性永久受损。严重程度从数据不一致到分析结果不可用。

#### 13.2 如何解决

**修改文件**: `src/shard/shard-manager.ts`

**实现思路**:

```typescript
async deleteNode(nodeId: string): Promise<void> {
  // 1. 获取所有关联边（保护性读取，防止并发修改）
  const edges = await this._storage.getEdgesByNode(nodeId);
  
  // 2. 批量删除关联边
  if (edges.length > 0) {
    await this._storage.batchDeleteEdges(edges.map(e => e.id));
    logger.info(`Deleted ${edges.length} edges associated with node ${nodeId}`);
  }
  
  // 3. 删除节点本身
  await this._storage.deleteNode(nodeId);
  
  // 4. 清理缓存（event-stream、local cache 等）
  this._cache?.clear(nodeId);
  this._eventStream?.emit('node-deleted', { nodeId, edgeCount: edges.length });
}
```

**修改量**: ~30 行 | **接口变更**: 无（deleteNode 签名不变）

#### 13.3 npm 包研究与选择

无需引入新 npm 包。

#### 13.4 是否需要自研

无需自研。

**推荐方案**: 先查关联边 → 批量删除边 → 删除节点 → 清理缓存。

#### 13.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-13.1 | 正常级联删除 | 创建节点 A + 边 A→B, A→C, A→D（共 3 条边），调用 deleteNode('A') | 节点 A 和 3 条关联边全部被删除 | 基本功能 |
| TC-13.2 | 孤立节点删除 | 创建孤立节点（无边，无出度），调用 deleteNode | 节点被删除，存储一致 | 边界条件 |
| TC-13.3 | 删除后孤儿边查询 | 创建一个节点 + 边，仅通过底层存储 deleteNode（模拟 bug），然后查询该节点的邻接表 | 返回空（无边残留） | 基本功能 |
| TC-13.4 | 删除后重建同 ID 节点 | 先删除节点 A，立即创建同名节点 A | 新节点 A 无残留边 | 边界条件 |
| TC-13.5 | 并发删除同一节点 | 两个线程同时调用 deleteNode('A') | 只删除一次，不报错 | 并发 |
| TC-13.6 | 并发删除关联节点 | 线程 1 删除 A，线程 2 删除 B（A→B 有边） | 边 A→B 在其中一个删除时被清理 | 并发 |
| TC-13.7 | 大关联量删除 | 节点有 10K 条关联边，批量删除 | 正常完成 <1s | 性能 |
| TC-13.8 | 删除后索引清理 | deleteNode 后，查询 full-text/vector 索引 | 无该节点的残留索引条目 | 基本功能 |

---

### 14. Rebalance draining修复 (P1, shard/rebalancer.ts)

#### 14.1 问题是什么

**文件**: `src/shard/rebalancer.ts:339`

**代码模式**:

```typescript
async rebalance(shardId: string): Promise<void> {
  // Phase 1: Drain
  await this._markDrain(shardId, true);
  
  // 迁移数据
  const data = await this._readAllData(shardId);
  await this._targetShard.writeBatch(data);
  
  // ❌ 问题：此处临时解除了 drain
  await this._markDrain(shardId, false);
  
  // ❌ 问题：此窗口期有新的写入落到源分片
  // 但随后以下代码会删除源分片 → 此窗口期的写入丢失
  
  // Phase 2: 删除源数据
  await this._deleteSourceData(shardId);
}
```

**问题本质**: 
- rebalance 过程中 drain 在数据迁移完成后被解除，然后源数据被删除
- 在 drain 解除的瞬间到数据删除之间，如果有新的写入到达，它会落到源分片
- 随后源分片被删除 → 窗口期的数据永久丢失
- 这是一个经典的 TOCTOU（Time-of-Check-to-Time-of-Use）问题

**触发场景**: 任何分片迁移/rebalance 操作。如果在网络分区或高负载下，窗口期可能被放大。

**影响范围**: 分片迁移时的稳态数据丢失。概率不高但一旦发生无法恢复。

#### 14.2 如何解决

**修改文件**: `src/shard/rebalancer.ts`

**实现思路**: 使用两阶段协议：
1. Phase 1: Drain（标记只读），停止所有新写入
2. Phase 2（在 drain 锁持有下）：迁移数据 → checksum 校验 → 删除源数据 → 释放 drain

```typescript
async rebalance(shardId: string): Promise<void> {
  // Phase 1: Drain — 标记只读
  await this._markDrain(shardId, true);
  
  try {
    // 迁移数据（drain 锁持有中）
    const data = await this._readAllData(shardId);
    await this._targetShard.writeBatch(data);
    
    // Checksum 校验确保数据迁移完整
    const checksum = await this._computeChecksum(shardId);
    const targetChecksum = await this._targetShard.computeChecksum();
    if (checksum !== targetChecksum) {
      throw new Error(`Checksum mismatch during rebalance: ${shardId}`);
    }
    
    // Phase 2: 仍持有 drain 锁的情况下删除源数据
    await this._deleteSourceData(shardId);
  } catch (err) {
    // 失败时回滚：释放 drain + 清理目标分片
    await this._targetShard.clear();
    logger.error(`Rebalance failed for ${shardId}`, err);
    throw err;
  } finally {
    // 最终释放 drain
    await this._markDrain(shardId, false);
  }
}
```

**修改量**: ~40 行 | **接口变更**: 无

#### 14.3 npm 包研究与选择

无需引入新 npm 包。

#### 14.4 是否需要自研

无需自研。

**推荐方案**: 数据迁移完成前不释放 drain 锁 + checksum 校验 + 清理后释放。

#### 14.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-14.1 | 正常 rebalance | 分片 shard-1（含 1000 条数据）rebalance 到新节点 | 数据完整迁移，校验一致 | 基本功能 |
| TC-14.2 | 迁移中的写入排队 | drain 标记后、删除前，一个客户端尝试写入该分片 | 写入被拒绝/排队，提示 "shard draining" | 并发 |
| TC-14.3 | 目标节点离线 | rebalance 过程中目标节点宕机 | 回滚：源分片保持 drain + 数据不变 | 异常路径 |
| TC-14.4 | 大分片迁移 | 迁移 100K 条数据的分片 | 正常完成，checksum 一致 | 性能 |
| TC-14.5 | 并发 rebalance | 同时 rebalance shard-1 和 shard-2 | 两个独立完成，不相互影响 | 并发 |
| TC-14.6 | 无数据分片 | rebalance 空分片 | drain → 校验（空）→ 删除 → 释放 drain | 边界条件 |

---

### 15. 48h cleanup持久化 (P1, reshard-manager.ts)

#### 15.1 问题是什么

**文件**: `src/shard/reshard-manager.ts:173`

**原始代码**:
```typescript
setTimeout(() => {
  this._cleanupExpiredData();
}, 48 * 60 * 60 * 1000  // 48h后执行一次
).unref();  // 进程不等待此定时器退出
```

**问题本质**:
1. `setTimeout.unref()` — 进程在定时器触发前退出，cron 永久丢失
2. 单次执行 — 触发一次后不再调度
3. 无持久化 — 重启后不知道上次 cleanup 时间，不执行

**影响范围**: 存储无限增长。所有 TTL 数据永不清理。

#### 15.2 如何解决

**修改文件**: `src/shard/reshard-manager.ts`

**实现思路**:
- 持久化 `last_cleanup_time` 到 LMDB/JSON 文件
- 每小时定时检查是否超 48h
- 启动时读取 lastCleanup，超时则立即执行

```typescript
async init(): Promise<void> {
  const lastCleanup = await this._persistState.get('last_cleanup_time');
  const now = Date.now();
  if (!lastCleanup || (now - lastCleanup) >= 48 * 60 * 60 * 1000) {
    await this._doCleanup(now);
  }
  setInterval(() => this._checkCleanup(), 60 * 60 * 1000);
}
```

**修改量**: ~60 行 | **接口变更**: 无

#### 15.3 npm 包研究与选择

无需引入新 npm 包。持久化用已有存储后端或 JSON 文件。

#### 15.4 是否需要自研

无需自研。

**推荐方案**: 持久化 `last_cleanup_time` + 每小时定时检查 + 启动时判断超 48h。去掉 `unref()`。

#### 15.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-15.1 | 首次启动 | 全新部署启动 | 立即执行 cleanup | 基本功能 |
| TC-15.2 | 正常调度 | lastCleanup=47h前，等1h检查 | 1h后触发cleanup | 基本功能 |
| TC-15.3 | 重启恢复 | lastCleanup=49h前，重启 | 启动后立即cleanup | 基本功能 |
| TC-15.4 | 重启恢复(未超) | lastCleanup=1h前，重启 | 不执行cleanup | 边界 |
| TC-15.5 | 持续运行72h | 进程连续运行72h | cleanup在48h附近发生 | 性能 |
| TC-15.6 | 持久化一致性 | 重启前后读取持久化值 | 一致 | 基本功能 |

---

### 16. 全量logger替换console（37处）(P1)

#### 16.1 问题是什么

**涉及文件**: 全库约 15 个源文件，共 37 处 console 调用。

**典型代码**:
```typescript
// shard-manager.ts
console.log(`Shard ${shardId} initialized`);
// event-stream.ts
console.error('Failed to handle remote data:', err);
// transport.ts
console.warn('Connection lost, retrying...');
```

**问题本质**:
1. 无 traceId — 无法关联到具体请求
2. 不可路由 — stdout/stderr 无法按级别分发
3. 不可查询 — 生产环境 grep 困难
4. 不可过滤 — 无法动态调整日志级别
5. 无审计记录 — 关键错误不被审计系统捕获

#### 16.2 如何解决

**创建日志模块** `src/lib/logger.ts`:

```typescript
import pino from 'pino';
import { AsyncLocalStorage } from 'async_hooks';

const asyncLocalStorage = new AsyncLocalStorage();

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  mixin() {
    const store = asyncLocalStorage.getStore();
    return store ? { traceId: store.traceId } : {};
  },
});

// 使用: logger.info({ nodeId }, 'Node upserted');
```

**替换规则**: `console.log` → `logger.info`, `console.error` → `logger.error`, `console.warn` → `logger.warn`

**修改量**: 引入 `pino` + 创建 logger.ts(~40行) + 替换37处(~74行) = ~114行

#### 16.3 npm 包研究与选择

| 候选 | 大小 | TS声明 | 纯嵌入 | 许可 | 维护状态 | 性能(ops/s) | 推荐 |
|------|:----:|:------:|:------:|:----:|:--------:|:----------:|:----:|
| **pino** | ~100KB | ✅ | ✅ | MIT | 活跃 | 50K+ | ✅ |
| winston | ~200KB | ✅ | ✅ | MIT | 活跃 | 10K+ | ⚠️稍重 |
| loglevel | ~10KB | ✅ | ✅ | MIT | 低活跃 | 30K+ | ⚠️功能少 |

**推荐 pino**: 官方宣称比 JSON stringify 还快，通过 `sonic-boom` 零开销写入。

#### 16.4 是否需要自研

无需自研。pino 完全满足需求。

**推荐方案**: `pino` + AsyncLocalStorage traceId + 全量替换。

#### 16.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-16.1 | 无 console 残留 | grep -r "console.log\|console.error\|console.warn" src/ (排除 logger.ts) | 0 处 | 基本功能 |
| TC-16.2 | 日志级别 | LOG_LEVEL=warn 后调用 logger.info | 不输出 | 基本功能 |
| TC-16.3 | traceId 注入 | withContext('tid') 内调用 logger.info | JSON 含 traceId | 基本功能 |
| TC-16.4 | 无 traceId 降级 | 不在 withContext 中调用 | 不报错，无 traceId 字段 | 边界 |
| TC-16.5 | 性能 | 10K 次 logger.info | <200ms | 性能 |
| TC-16.6 | JSON 可解析 | 输出 100 行 | 每行合法 JSON | 基本功能 |
| TC-16.7 | Error 堆栈 | logger.error(new Error('test')) | 含 stack 字段 | 基本功能 |

---

## 六、Phase C 详细分析 — 竞品差距填补 5 项

---

### 17. Cypher-lite扩展至完整DML (Phase C)

#### 17.1 问题是什么

**文件**: `src/query/cypher-lite.peggy` (peggy grammar)、`src/query/execution-plan.ts`、`src/query/engine-adapter.ts`

**当前能力**(<30% 标准 Cypher): 仅 `MATCH` / `RETURN` / `WHERE` / `ORDER BY` / `LIMIT`.

**缺少**: `CREATE` / `DELETE` / `MERGE` / `SET` / `REMOVE` / `FOREACH` / `UNWIND` / `CALL`.

**影响**: 查询语言评分 5/10 vs 10/10(Neo4j)。所有写入只能通过 Fluent API。

#### 17.2 如何解决

**修改文件**:
1. `cypher-lite.peggy` — 扩展 grammar (+500行)
2. `execution-plan.ts` — 扩展执行计划构建 (+200行)
3. `engine-adapter.ts` — 适配引擎调用 (+300行)

**实现优先级**: CREATE -> DELETE -> SET -> MERGE -> REMOVE -> FOREACH

**peggy grammar 示例(CREATE)**:
```pegjs
Create = "CREATE"i _ pattern:CreatePattern
  { return { type: 'CREATE', pattern }; }
CreatePattern = "(" _ name:Var _ ":" _ label:Label _ "{" _ props:PropMap _ "}" _ ")"
```

**修改量**: ~1000 行 | **接口变更**: 无(Cypher 语法扩展向前兼容)

#### 17.3 npm 包研究与选择

无需引入新包。使用已有 peggy parser 继续扩展。

#### 17.4 是否需要自研

**需要自研**。核心功能开发，Cypher DML 语义绑定到 AgentiX 存储模型。

**推荐方案**: 分 5 Sprint 实现各关键字。从 CREATE 开始(覆盖 80% 写入场景)。

#### 17.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-17.1 | CREATE node | `CREATE (n:Person {name:'Alice', age:30})` | 创建成功，属性正确 | 基本功能 |
| TC-17.2 | CREATE edge | `MATCH (a),(b) CREATE (a)-[:KNOWS]->(b)` | 边创建成功 | 基本功能 |
| TC-17.3 | DELETE node | `MATCH (n:Person) DELETE n` | 节点+关联边删除 | 基本功能 |
| TC-17.4 | DELETE 空匹配 | `MATCH (n:Nonexistent) DELETE n` | 成功，不报错 | 边界 |
| TC-17.5 | SET 属性 | `MATCH (n) SET n.age=31` | 属性更新 | 基本功能 |
| TC-17.6 | MERGE | `MERGE (n:Person {id:'001'}) ON CREATE SET n.name='Alice'` | upsert 语义 | 基本功能 |
| TC-17.7 | 链式 CREATE | `CREATE (a:Person)-[:KNOWS]->(b:Person)` | 两点一边 | 基本功能 |
| TC-17.8 | 已有查询兼容 | 运行已有的 20 条 MATCH 查询 | 全部通过 | 向后兼容 |
| TC-17.9 | 语法错误 | `CREATE `(不完整) | 友好错误 | 异常路径 |
| TC-17.10 | 性能 | UNWIND + CREATE 10K 节点 | <5s | 性能 |
| TC-17.11 | 原子性 | CREATE (a)-[:E]->(b) 中途失败 | 无孤儿节点/边 | 异常路径 |

---

### 18. OverGraph深度调优（50K ops目标）(Phase C)

#### 18.1 问题是什么

**文件**: `src/core/overgraph-storage.ts`

**当前性能**: ~8K ops/sec. 竞品: Neo4j 50K-100K, CozoDB 30K-50K.

**瓶颈推测**:
- HNSW 参数默认值: M=12, efConstruction=100, efSearch=40
- LMDB mapSize 固定值不合理
- 写入路径串行, 每次单独 flush WAL
- Rust-JS 零拷贝路径有额外序列化

#### 18.2 如何解决

**参数调优方案**:
```typescript
const config = {
  hnsw: { m: 16, efConstruction: 200, efSearch: 50, maxElements: 1_000_000 },
  lmdb: { mapSize: Math.min(os.freemem() * 0.5, 4 * 1024 ** 4), maxDbs: 10, writeMap: true },
  batch: { maxBatchSize: 1000, maxBatchDelay: 10 },
};
```

**批量写入优化**: 合并写入操作到缓冲区, 满 1000 条或 10ms 周期 flush.

**修改量**: ~150 行 | **接口变更**: config 结构可能变化

#### 18.3 npm 包研究与选择

无需引入新包。使用 OverGraph 原生 API + `os.freemem()`。

#### 18.4 是否需要自研

无需自研。纯参数调优 + 代码优化。

**推荐方案**: HNSW M=16/efConstruction=200 + LMDB autoSize + 批量写入合并。

#### 18.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-18.1 | 写入吞吐 | 8 并发 writer 写入 50K 节点(128维向量) | >=50K ops/sec | 性能 |
| TC-18.2 | 搜索延迟 | 10K 数据集 k=10 搜索 1000 次 | P50<1ms, P99<10ms | 性能 |
| TC-18.3 | 召回率 | 100 次随机查询 vs brute-force | recall@10 >= 95% | 基本功能 |
| TC-18.4 | 内存增长 | 100K 向量后 heapUsed | 增长<=100MB | 性能 |
| TC-18.5 | 配置可调 | efSearch=200 后查询 | 召回提高+延迟增加 | 边界 |
| TC-18.6 | 长稳 1h | 200 ops/sec + 随机查询 | 无泄漏, 延迟不漂移 | 性能 |
| TC-18.7 | 批量正确性 | 批量写入 1000 条后全量查询 | 1000 条都存在 | 基本功能 |

---

### 19. CJK分词支持 (Phase C)

#### 19.1 问题是什么

**文件**: `src/fulltext/search.ts` (MiniSearch 配置)

**当前问题**: MiniSearch 默认 simple tokenizer 按空格/标点分割。
CJK 文字无分隔符: "我爱北京天安门" 被当作一个完整 token。
搜索"北京"无法匹配 -> CJK 全文搜索完全不可用。

**竞品差距**: 评分 4/7 (AgentiX vs Neo4j TypeSense)。

#### 19.2 如何解决

**方案**: 使用 `nodejieba` 作为 MiniSearch tokenizer。

```typescript
import { cut } from 'nodejieba';

const cjkTokenizer = (text: string) => {
  if (/[\u4e00-\u9fff]/.test(text)) return cut(text, true);
  return text.split(/[\s,.!?]+/).filter(Boolean);
};

new MiniSearch({
  fields: ['title', 'content'],
  tokenize: cjkTokenizer,
  processTerm: (term) => term.toLowerCase(),
  searchOptions: { prefix: true, fuzzy: 0.2 },
});
```

**修改量**: ~50 行 | **接口变更**: 无

#### 19.3 npm 包研究与选择

| 候选 | 大小 | TS声明 | 纯嵌入 | 许可 | 维护状态 | CJK质量 | 推荐 |
|------|:----:|:------:|:------:|:----:|:--------:|:-------:|:----:|
| **nodejieba** | ~5MB(含词典) | Y | Y | MIT | 活跃 | 优秀 | YES |
| @node-rs/jieba | ~4MB | Y | Y | MIT | 活跃 | 优秀 | 备选 |
| segmentit | ~2MB | N(纯JS) | Y | MIT | 低维护 | 良好 | NO |

**推荐 nodejieba**: 最成熟的结巴分词 Node.js 绑定, 纯嵌入式(不需外部服务), MIT 许可。
首次加载词库约 3s, 内存 ~30MB。词典内置, 无网络依赖。

#### 19.4 是否需要自研

无需自研。nodejieba 完全满足需求。

**推荐方案**: nodejieba 自定义 MiniSearch tokenizer, 同时支持 CJK 和英文分词。

#### 19.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-19.1 | 中文分词 | 搜索"北京"在包含"我爱北京天安门"的文档中 | 匹配到 | 基本功能 |
| TC-19.2 | 英文分词 | 搜索"hello"在"hello world"中 | 匹配到 | 基本功能 |
| TC-19.3 | 中英混合 | 搜索"北京 AI"在"北京 AI 公司"中 | 两者都匹配到 | 基本功能 |
| TC-19.4 | 日文 | 搜索"東京"在日文文档中 | 匹配到 | 基本功能 |
| TC-19.5 | 搜索空字符串 | 搜索 "" | 不报错, 返回空数组 | 边界 |
| TC-19.6 | 不存在词 | 搜索在文档中不存在的词 | 返回空数组 | 边界 |
| TC-19.7 | 性能 | 索引 10K 中文文档 + 执行 100 次搜索 | 总耗时 <5s | 性能 |
| TC-19.8 | 内存 | 加载 nodejieba 后 RSS 增量 | <30MB | 性能 |
| TC-19.9 | 降级策略 | nodejieba 模块不可用 | 降级到默认 tokenizer, 输出警告日志 | 异常路径 |

---

### 20. Web Dashboard v1 (Phase C)

#### 20.1 问题是什么

**现状**: 无任何 Web UI。全 CLI/REST API 操作。
竞品标配: Neo4j Browser, ArangoDB WebUI, Dgraph Ratel。

**运维痛点**:
- 查看集群状态需要 curl + 解析 JSON
- 执行查询需要 curl 或 gRPC 客户端
- 监控指标无法可视化
- 图数据无法直观查看

#### 20.2 如何解决

**技术栈**: React + Vite + D3.js(拓扑图) + Chart.js(监控) + CodeMirror(查询编辑器原生支持 Cypher 语法高亮)

**v1 MVP 功能**:
1. **集群状态页**: 节点列表、分片分布、Leader 展示、健康检查
2. **查询执行**: 查询输入框(语法高亮) + 结果表格
3. **拓扑可视化**: 图数据渲染为节点-边有向图(D3 force layout)
4. **基本监控**: QPS/延迟/错误率的折线图
5. **连接配置**: 后端地址和认证配置

**架构**: SPA (build -> dist) + 反向代理 -> 复用已有 REST API

**修改量**: ~2000 行(TypeScript/React + CSS) | **接口变更**: 无(复用已有 API)

#### 20.3 npm 包研究与选择

| 候选 | 大小 | 许可 | 用途 | 推荐 |
|------|:----:|:----:|:-----|:----:|
| React 18 + Vite | ~120KB(gzip) | MIT | SPA 框架 | YES |
| D3.js (v7) | ~250KB(gzip) | ISC | 图可视化 force layout | YES |
| Chart.js + react-chartjs-2 | ~60KB | MIT | 监控图表 | YES |
| CodeMirror 6 (codemirror/lang-cypher) | ~500KB | MIT | 查询编辑器(原生 Cypher 语法高亮) | YES |
| Monaco Editor | ~10MB | MIT | VS Code 编辑器 | NO(太重) |

**推荐**: React 18 + Vite + D3 v7 + Chart.js + CodeMirror 6.

#### 20.4 是否需要自研

UI 应用层需要自研(业务逻辑/布局/状态管理), 但核心可视化组件使用现有 npm 包。

**推荐方案**: React + Vite + D3.js + Chart.js + CodeMirror.

#### 20.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-20.1 | 集群状态 | 打开 Dashboard | 显示所有节点、分片分布、Leader | 基本功能 |
| TC-20.2 | 查询执行 | 输入 MATCH (n) RETURN n, 点击执行 | 显示结果表格/JSON | 基本功能 |
| TC-20.3 | 拓扑可视化 | 执行有边关系的图查询 | 渲染 D3 force 节点-边图 | 基本功能 |
| TC-20.4 | 监控面板 | 打开 Metrics 面板 | 折线图显示 QPS/延迟/错误率 | 基本功能 |
| TC-20.5 | 语法高亮 | 输入 Cypher 查询 | CodeMirror 正确高亮关键字/变量 | 基本功能 |
| TC-20.6 | 查询错误 | 输入语法错误的查询 | 显示友好错误提示(含错误位置) | 异常路径 |
| TC-20.7 | 空集群 | 新部署空集群 | Dashboard 正常加载, 显示空状态提示 | 边界 |
| TC-20.8 | 大结果集 | 查询返回 10K 行 | 分页显示(每页 100 行), 浏览器不卡 | 性能 |
| TC-20.9 | 后端离线 | 停止后端服务 | Dashboard 显示"连接失败"等错误提示 | 异常路径 |
| TC-20.10 | 长稳 | 保持 Dashboard 打开 1h, 自动刷新 | 无内存泄漏, 标签页不崩溃 | 性能 |

---

### 21. 性能基准公开页面 (Phase C)

#### 21.1 问题是什么

**现状**: 项目无公开性能基准页面。用户无从判断 AgentiX 的性能水平。
竞品(Neo4j, CocoDB, Typesense)均有公开的 LDBC SNB、YCSB 等基准数据。

#### 21.2 如何解决

**技术方案**: 静态站点 (GitHub Pages / Vercel / Netlify)。

**页面内容**:
1. **写入吞吐**: 对比 AgentiX vs Neo4j/CozoDB/Typesense/Kuzu
2. **向量搜索延迟**: QPS vs batch size 图表
3. **图遍历性能**: BFS 深度 vs 耗时的基准
4. **内存/磁盘使用**: 数据集大小 vs 存储占用
5. **混合查询**: 向量 + 全文搜索的基准

**实现**:
- 纯静态 HTML + Chart.js (CDN 引用)
- 性能数据存储在公开 JSON 文件中
- CI 自动更新: 每次 benchmark 运行后更新 JSON 和图表

**修改量**: ~500 行(HTML/CSS/JS) | **接口变更**: 无

#### 18.3 npm 包研究与选择

纯静态页面, 通过 CDN 引入 Chart.js 即可。无需后端或 npm 依赖。

#### 18.4 是否需要自研

需要自研页面内容和布局构建。但核心图表渲染使用 Chart.js。

**推荐方案**: GitHub Pages + Chart.js + 性能数据 JSON + CI 自动更新。

#### 18.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-21.1 | 页面加载 | 访问公开 URL | 页面完整渲染, 无 JS 错误 | 基本功能 |
| TC-21.2 | 写入吞吐图 | 查看写入吞吐对比图表 | Chart.js 渲染正确, 含 AgentiX 和竞品 | 基本功能 |
| TC-21.3 | 竞品对比表 | 查看性能对比表格 | 显示完整对比数据 | 基本功能 |
| TC-21.4 | 数据一致性 | 对比 JSON 数据文件和页面渲染值 | 完全一致 | 基本功能 |
| TC-21.5 | 响应式 | 手机浏览器访问 | 布局适配屏幕大小 | 边界 |
| TC-21.6 | SEO | 搜索引擎抓取页面 | 页面含 title/meta description/heading | 边界 |
| TC-21.7 | 加载速度 | Lighthouse 测试 | Performance >= 90 | 性能 |
| TC-21.8 | CDN 降级 | Chart.js CDN 不可用 | 不崩溃, 显示提示文本 | 异常路径 |

---




## 七、Phase D 详细分析 — 差异化突破

---

### 22. 分片Raft组自管理（正式成员变更）

#### 22.1 问题是什么

**文件**: 分片管理层 + Raft 共识层

**问题本质**: 当前 Raft 组成员变更是"伪实现"——成员配置变更（add/remove peer）没有实现正式的 Raft 成员变更协议（single-server / joint consensus）。直接增删 peer 不保证安全性。

**影响范围**: 集群扩缩容时可能发生脑裂或数据丢失。

#### 22.2 如何解决

**实现思路**:
- 实现 Raft 单节点变更（single-server change）：一次只添加/删除一个 peer
- 实现 joint consensus（可选，用于同时添加/删除多个 peer）
- 变更过程中所有 Raft group 内的节点保持一致

**修改文件**: `src/consensus/raft-logic-consensus.ts`（约 300 行）

#### 22.3 npm 包研究与选择

**候选方案**:

| 候选 | 说明 | 推荐 |
|------|------|:----:|
| raft-logic (现有) | 已在用，需扩展成员变更支持 | ✅ |
| `node-raft` | JS 实现，功能完整 | ⚠️ 需重写绑定 |
| 自研 | 基于 raft-logic 扩展 | ✅ |

**推荐**: 基于已有的 `raft-logic` 库扩展成员变更功能。不需要替换共识库。

#### 22.4 是否需要自研

部分自研（扩展已有 raft-logic 的成员变更功能）。

**推荐方案**: 在现有 raft-logic 共识层实现 Raft 单节点成员变更协议。

#### 22.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-22.1 | 添加节点 | 3 节点集群添加第 4 个节点 | 新节点加入，数据同步 | 基本功能 |
| TC-22.2 | 删除节点 | 3 节点集群删除 1 个节点 | 2 节点继续，数据完整 | 基本功能 |
| TC-22.3 | 并发变更 | 同时添加 2 个节点 | 顺序执行，最终一致 | 并发 |
| TC-22.4 | 变更中故障 | 变更过程中 Leader 离线 | 选举出新 Leader，变更继续或回滚 | 异常路径 |
| TC-22.5 | 脑裂防护 | 网络分区下执行成员变更 | 变更不生效 | 安全 |
| TC-22.6 | 持续运行 | 不断执行 add/remove 共 10 次 | 集群始终可用，数据一致 | 性能 |

---

### 23. 向量-全文混合查询

#### 23.1 问题是什么

**文件**: 查询执行层

**问题本质**: 向量搜索（OverGraph HNSW）和全文搜索（MiniSearch）是完全隔离的两套系统。没有混合查询能力——例如：搜索"北京 + 相似度 > 0.8"（语义搜索 + 关键词过滤）需要在应用层手动组合。

**影响范围**: 缺少竞品（如 CozoDB、Qdrant 等）都支持的混合搜索能力。

#### 23.2 如何解决

**实现思路**:
- OverGraph HNSW 返回 top-K 向量候选
- MiniSearch 返回 top-K 全文候选
- 在应用层使用 Reciprocal Rank Fusion (RRF) 融合
- 扩展查询语法：`MATCH (n) WHERE n.vector SIMILAR TO [...] AND n.title =~ 'keyword'`

```typescript
async hybridSearch(params: {
  vector: number[],
  fulltext: string,
  topK: number,
  alpha?: number  // RRF 参数
}): Promise<Result[]> {
  const [vectorResults, fulltextResults] = await Promise.all([
    this.vectorSearch(params.vector, params.topK * 2),
    this.fulltextSearch(params.fulltext, params.topK * 2),
  ]);
  
  // RRF 融合
  return this._rrfMerge(vectorResults, fulltextResults, params.topK, params.alpha || 60);
}
```

**修改量**: ~200 行 | **接口变更**: 新增 `hybridSearch` API

#### 23.3 npm 包研究与选择

无需引入新包。RRF 算法 ~20 行代码。

#### 23.4 是否需要自研

核心逻辑（RRF 融合）纯代码即可。语法的扩展部分需要自研。

**推荐方案**: OverGraph + MiniSearch 联合查询 + RRF 融合 + 查询语法扩展。

#### 23.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-23.1 | 混合搜索 | 向量搜索"猫" + 全文"宠物" | 返回同时匹配的结果 | 基本功能 |
| TC-23.2 | 纯向量退化 | 全文为空时的混合搜索 | 退化为纯向量搜索 | 边界 |
| TC-23.3 | 纯全文退化 | 向量为空时的混合搜索 | 退化为纯全文搜索 | 边界 |
| TC-23.4 | 空结果 | 都不匹配时 | 返回 [] | 边界 |
| TC-23.5 | 召回率对比 | 对比混合 vs 纯向量/纯全文 | 混合搜索召回率 ≥ 单种 | 性能 |
| TC-23.6 | 延迟 | 10K 向量 + 10K 文档查询 | P99 < 50ms | 性能 |
| TC-23.7 | RRF 参数调优 | 调整 alpha | 排序变化正确 | 基本功能 |

---

### 24. CI/CD + 安全审计自动化

#### 24.1 问题是什么

**现状**: 项目无自动化 CI/CD。无安全审计流程。
- 每次提交手动构建和测试
- 无 SAST (Static Application Security Testing)
- 无依赖漏洞扫描
- 无代码质量门禁

#### 24.2 如何解决

**实现思路**:
- GitHub Actions 工作流
- 每次 PR 运行：tsc 编译、单元测试、integration 测试
- 安全扫描：`npm audit`、`eslint-plugin-security`、`lockfile-lint`
- 代码质量：TypeScript strict 模式

**修改文件**: 新建 `.github/workflows/ci.yml`

```yaml
name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run build
      - run: npm test
      - run: npm audit
      - run: npx eslint --plugin security .
```

**修改量**: ~50 行 | **接口变更**: 无

#### 24.3 npm 包研究与选择

| 候选 | 用途 | 推荐 |
|------|------|:----:|
| `eslint-plugin-security` | 安全 lint 规则 | ✅ |
| `npm audit` | 依赖漏洞扫描（内置） | ✅ |
| `lockfile-lint` | lockfile 完整性 | ⚠️ 可选 |
| `codeql` | GitHub 内置 SAST | ✅ |

#### 24.4 是否需要自研

无需自研。使用现有工具组合。

**推荐方案**: GitHub Actions + npm test + eslint-security + npm audit + CodeQL。

#### 24.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-24.1 | CI 触发 | PR 创建 | 自动触发 CI | 基本功能 |
| TC-24.2 | 构建成功 | 干净代码提交 | 全部 job 通过 | 基本功能 |
| TC-24.3 | 构建失败 | 提交编译错误 | CI 失败，不通过 | 基本功能 |
| TC-24.4 | 安全扫描 | 提交含有漏洞的依赖 | npm audit 报警 | 安全 |
| TC-24.5 | lint 检查 | 提交违反安全规则 | eslint 报警 | 安全 |
| TC-24.6 | CodeQL | PR 中含有注入风险 | CodeQL 报警 | 安全 |

---

## 八、交叉模式总结

### 暗逻辑丢失
- TCP sendTo 静默失败、双写目标静默 catch、affinity hash 碰撞 — 均无声吞错误
- 所有路径缺少可观测性，有错但不报

### 一致性折衷未文档化
- BFS 非事务遍历、draining 开窗期、engine open 先于 consensus
- 每个都是语义差异，但接口无文档标注

### 持久性 gap
- persistMeta 无锁、48h cleanup 无持久化、CDC offset 仅存内存
- Raft 元数据和安全清理都在不确定性中

### 外部依赖风险
- raft-logic 来自 codeberg 个人仓库，better-sqlite3 native addon 在 alpine 需要编译

### 测试盲区
- 无安全注入测试、无 RLS 越权测试、无 bodySizeLimit 413 测试
- 无内存泄漏/长稳测试（1000+ ops）
- 并发测试未用 `-race` 检测器
- 2 个故障注入测试文件为 0 测试（skeleton，已补充）

---

## 九、Phase 间依赖关系

```
Phase A (1-2天) ─────────── 独立可并行
      │
      ▼
Phase B (1周) ───────────── 依赖 Phase A 完成后再开始
      │
      ├── 项 9-12（安全加固）── 与 Phase A 无关但建议先修 P0
      ├── 项 13-16（数据完整性+可观测性）── 可并行于 9-12
      │
      ▼
Phase C (2-4周) ────────── 依赖 Phase B 基础稳定
      │
      ├── 项 17（Cypher扩展）── 可并行于 18-21
      ├── 项 18（性能调优）── 可并行于 17/19-21
      ├── 项 19（CJK分词）── 独立
      ├── 项 20（Dashboard）── 独立
      ├── 项 21（基准页面）── 依赖 18 的性能数据
      │
      ▼
Phase D (1-3月) ────────── 依赖 Phase C 能力完整
      │
      ├── 项 22（Raft成员变更）── 与 Phases C 非严格依赖
      ├── 项 23（混合查询）── 依赖 17(Cypher) + 18(性能)
      ├── 项 24（CI/CD）── 独立，可随时开始
```

---

## 十、风险矩阵

| 风险 | 概率 | 影响 | 缓解措施 |
|:-----|:----:|:----:|:---------|
| raft-logic 外部库不可维护 | 中 | 高 | 自研 Raft 实现备选 |
| better-sqlite3 Alpine 不兼容 | 低 | 中 | Docker 构建 + 预编译 binary |
| Phase C 性能目标达不到 | 中 | 中 | 设定可接受的次优目标（30K ops） |
| 团队成员不熟悉 Cypher 语法 | 高 | 中 | 分步实现，先 CREATE 再 MERGE |
| nodejieba 内存占用高 | 低 | 低 | 使用 @node-rs/jieba 替代 |
| Dashboard 工作量被低估 | 中 | 中 | v1 只做最小功能集 |

---

*报告生成时间: 2026-05-26 10:43 GMT+8*  
*版本: V3.1 — 含 24 项详细分析*
