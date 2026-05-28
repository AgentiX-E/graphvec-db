# R6/R16 真实 ZMQ 测试计划

## 目标
利用已安装的 zeromq v4.3.5 npm 包，基于真实 ZMQ 端口绑定编写两个集成测试，关闭 final-audit 的 🟡 覆盖缺口。

---

## 测试 1: R16 CURVE 真实 ZMQ 错误场景

**文件**: `test/integration/curve-real-zmq.test.ts`

### 测试策略
- 使用真实 `zeromq.curveKeyPair()` 生成密钥
- 写入临时 `.pub` 文件模拟对端公钥
- 用 `zeromq.Dealer` 和 `zeromq.Router` 套接字直接做握手
- 测试 ZMQ 层面 CURVE 连接行为（密码学意义上，不是 mock）

### 测试用例
1. **CURVE 正常握手** — server 有 client pubkey + client 有 server pubkey → DEALER 可连接 ROUTER
2. **Bad/missing serverKey** — client 缺 serverKey → CURVE 拒绝连接
3. **Bad/missing clientKey** — server 缺 client pubkey → CURVE 拒绝连接
4. **key 路径不存在** — readAllPeerKeys 空目录返回 []
5. **损坏的 .pub 文件** — 内容非 hex → readAllPeerKeys 安静跳过

### 关键设计
- 使用 `disableRouter: true` 模式避免 EventBus 配置冲突
- 直接声明 `zeromq.Router` / `zeromq.Dealer` 进行 CURVE 连接测试
- 不依赖 `EventBus.start()`（避免端口绑定竞态）

---

## 测试 2: R6 ZMQ Per-Peer Isolation

**文件**: `test/integration/per-peer-isolation.test.ts`

### 测试策略
- 启动 1 个 EventBus ROUTER（真实端口）
- 启动 3 个 EventBus DEALER，模拟 3 个 peer
- 停止其中一个 DEALER（模拟 peer 挂掉），验证其他 2 个 DEALER 通信不受影响

### 测试用例
1. **3 peer 正常通信** — 所有 DEALER 都能发送/接收
2. **失活 1 peer** — stop 1 个 DEALER，其他 2 个仍可正常发送
3. **peer 恢复** — restart 被停止的 DEALER，恢复通信

### 关键设计
- 每个 DEALER 在随机端口，连接到同一个 ROUTER
- 使用事件验证（EventStream）而非 sleep
- 超时保护：每个用例 10s
