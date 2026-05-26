# Item 3: TcpTransport sendTo ACK - 完成报告

创建时间: 2026-05-26 11:54
完成时间: 2026-05-26 12:09

## 测试结果

**4 个测试套件, 56 个测试全部通过** ✅

- `raft-transport.spec.ts` — 18 passed (含 4 个新 ACK 测试)
- `raft-integration.spec.ts` — 4 passed
- `raft-install-snapshot.spec.ts` — 6 passed
- `raft-logic-consensus.spec.ts` — 28 passed

## 改动摘要

### 1. `src/consensus/transport.ts`

#### `TcpFrame` 接口扩展
- 新增 `msgId?: string` 字段：发送方生成的消息 ID，用于 ACK 匹配
- 新增 `ackFor?: string` 字段：ACK 响应帧中携带原始消息 ID

#### `TcpTransport` 类新增属性和方法
- `ackTimeout: number = 5000` — ACK 超时时间（毫秒），可配置
- `_msgIdCounter: number` — 自增消息 ID 计数器
- `_pendingAcks: Map<string, PendingAck>` — 待 ACK 响应注册表
- `_ackTimers: Set<NodeJS.Timeout>` — 超时定时器集合
- `_acceptedSockets: Set<net.Socket>` — 所有已接受的连接跟踪，用于完整清理
- `_generateMsgId(): string` — 生成唯一消息 ID
- `_handleAck(msgId: string): void` — 处理 ACK 响应，resolve pending promise
- `_sendAck(socket: net.Socket, ackFor: string): void` — 发送 ACK 帧
- `sendToSync(peerId, msg): boolean` — 同步 fire-and-forget 兼容重载

#### `sendTo()` 返回值变更
- `sendTo()` 返回 `Promise<boolean>` — ACK 收到返回 true，超时返回 false
- `sendToSync()` 保留同步兼容，原有行为不变

#### `_sendWithAck()` 内部方法
- 检查 socket 状态，不存在时尝试重连
- 生成 msgId，注册 pending ACK
- 写入帧时携带 msgId
- 超时或异常时 resolve(false)，成功收到 ACK 时 resolve(true)

#### `_handleConnection()` 数据处理器
- ACK 帧处理：检测 `frame.type === 'ack'` 时转发到 `_handleAck()`
- 消息帧处理：检测到 `frame.msgId` 时自动发送 ACK 帧回写
- 跟踪所有 accepted sockets 用于完整清理

#### `broadcast()` 异步化
- 返回 `Promise<void>`，并发发送所有 peer，`await Promise.all()`

#### `stop()` 增强清理
- 拒绝所有 pending ACK
- 清理所有 ACK 定时器
- 销毁所有 accepted sockets（修复了之前 stop 不清理 incoming 连接的问题）

#### `installSnapshot()` 适配
- chunk 发送改用 `sendToSync()`（fire-and-forget，因为 chunk 有自己的重试逻辑）
- done 消息改用 `await sendTo()`（等待 ACK）

### 2. `src/consensus/raft-transport.spec.ts`

新增 4 个验收测试用例：

| # | 测试项 | 状态 |
|---|--------|------|
| TC-3.1 | 正常发送成功 | ✅ |
| TC-3.2 | 超时失败 | ✅ |
| TC-3.3 | 发送失败恢复 | ✅ |
| TC-3.4 | 批量压力 | ✅ |

同时更新了原有两个测试（未知 peer、disconnect 后发送）的 `sendTo()` 调用为 async/await。

## 注意事项

1. `sendTo()` 现在是 async，所有调用方需要 `await` 或 `.catch()`
2. 同步兼容通过 `sendToSync()` 保留，用于 fire-and-forget 场景
3. ACK 超时默认 5 秒，可通过 `transport.ackTimeout` 配置
4. 原有 `_handleConnection` 中不跟踪 accepted 连接的 bug 已被修复
