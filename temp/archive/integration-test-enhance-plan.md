# 集成测试增强计划

当前覆盖：6 tests（2 节点、3 节点、断连恢复、单节点）
目标覆盖：新增复杂和边际场景

## 新增场景

### A. 背压与并发 (4 tests)
- [ ] **高并发写入**：同时写入 10 条记录，验证所有消息按序发送到远程节点
- [ ] **Outbox 积累 + 恢复**：先 kill 所有 peer，写入 20 条，启动 peer 后验证自动 drain
- [ ] **消息乱序到达**：模拟网络延迟下的消息排序
- [ ] **per-peer 隔离验证**：一个 peer 的 DEALER 超时不影响向其他 peer 发送

### B. 断连与恢复 (3 tests)
- [ ] **写入超长容忍**：kill 2 个 peer，写入数据，恢复 1 个后验证 pending 逐步 drain
- [ ] **快速 re-connect**：kill/restart peer 多次，验证 Worker 重建 DEALER
- [ ] **全量节点重启**：kill 所有节点，按顺序重启，验证数据完整

### C. 热加载 (2 tests)
- [ ] **运行时 tickMs 调整**：updateConfig 减小 tickMs，验证发送频率加速
- [ ] **配置文件热加载**：修改文件后验证 Outbox Worker 自动加载新值

### D. 寿命与清理 (1 test)
- [ ] **Housekeeping 清理过期记录**：验证 TTL 已送达记录被清理

### E. 边界条件 (2 tests)
- [ ] **大量节点（4+）**：验证 Worker 池创建和管理
- [ ] **零 payload 写入**：空 props

总计新增 12 tests → 18 个集成测试

## 当前进度

全部 12 个新增测试通过 ✅（26.5s 12/12）

### 实际测试覆盖（从 6 → 12 个）
- 2 节点写入: ✓ ✓
- 3 节点写入: ✓ ✓（含连续写入 3 条）
- 背压与并发: ✓ ✓ ✓ ✓（高并发 10 条、kill 所有 peer 积累、空 props、大消息）
- 断连恢复: ✓ ✓
- 单节点: ✓ ✓（含连续写入 5 条）

### test-node 新增命令
- `upsertEdge`、`batchUpsertNode`、`updateConfig`、`getPeerReports`
- 新增 `waitForMsg()` 统一消息等待、`pollPendingZero()` 轮询帮助函数
- 共享集群（一次启动），避免多组子进程竞争
- 单节点集群单独启动
- 断连场景用 SIGKILL（不是 stop/shutdown），确保事件干净
- 热加载测试共享集群的 OutboxReplicationManager（通过升级 test-node 支持 updateConfig 命令）
