# Raft TCP 传输层集成 + 集成测试增强计划

创建时间: 2026-05-26 01:18

## 目标

1. 修复 `raft-logic-consensus.ts` 集成 TcpTransport（当前写死 InMemoryTransport）
2. 完善 raft-logic-consensus 单元测试
3. 新增跨进程 Raft TCP 集成测试（多子进程 + 网络传输）
4. 整合到全量测试

## 现状

- `src/consensus/transport.ts` — TcpTransport（~200 行）已有，通过 TcpTransport.register(port) / reset() 静态方法管理
- `src/consensus/raft-logic-consensus.ts` — `start()` 中写死 `new InMemoryTransport()`
- `src/consensus/raft-transport.spec.ts` — TcpTransport 单例通信测试，已有
- `src/consensus/raft-logic-consensus.spec.ts` — 12 个测试，使用 MockTransport

## 步骤

### Phase 1: raft-logic-consensus 集成 TcpTransport ✅
- [x] ConsensusConfig 新增 `transportPort?: number`
- [x] `start()` 动态 import TcpTransport 并适配为 raft-logic transport 接口
- [x] `stop()` 清理 TcpTransport

### Phase 2: 单元测试增强 ✅
- [x] 2 新测试：transportPort 配置、TcpTransport 适配器传递验证
- [x] raft-logic-consensus.spec.ts: 23/23 ✅

### Phase 3: 跨进程集成测试 ✅
- [x] 新建 `raft-test-node.ts`（子进程入口）
- [x] 新建 `raft-integration.spec.ts`（3 子进程 TCP 通信）
- [x] 4 测试：getRole、leader 选举、leader propose、follower propose

### Phase 4: 全量测试 ✅
- [x] 55 suites, 675 tests 全绿 (54.891s)
- [x] tsc 0 errors

## 改动文件

| 文件 | 改动 |
|------|------|
| `src/consensus/consensus-provider.ts` | ConsesusConfig 新增 transportPort |
| `src/consensus/raft-logic-consensus.ts` | start() 支持 TcpTransport 分支，stop() 清理 |
| `src/consensus/raft-logic-consensus.spec.ts` | 2 个 TcpTransport 模式新测试 (23→23) |
| `src/consensus/raft-test-node.ts` | **新增** 子进程入口 |
| `src/consensus/raft-integration.spec.ts` | **新增** 3 节点 TCP 集成测试 (4 tests) |
