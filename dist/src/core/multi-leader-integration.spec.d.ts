/**
 * multi-leader-integration.spec.ts — Multi-Leader 多进程集成测试
 *
 * @vitest-concurrent false
 *
 * 启动子进程（通过 npx tsx 执行），通过 stdin/stdout JSON line 通信。
 * EventBus 使用 NAS 模式（共享曲线密钥目录），自动发现 peer。
 *
 * 覆盖场景：
 *   - 基础：2 节点写入 + 3 节点写入 + 单节点
 *   - 断连恢复：kill 节点后写入 + pending drain + re-connect
 *   - 背压与并发：高并发写入 + Outbox 积累/恢复 + per-peer 隔离
 *   - 热加载：运行时 tickMs 调整
 *   - 边界条件：空 props 写入 + 大消息
 */
export {};
//# sourceMappingURL=multi-leader-integration.spec.d.ts.map