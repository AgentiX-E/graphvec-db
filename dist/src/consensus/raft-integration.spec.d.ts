/**
 * raft-integration.spec.ts — Raft 跨进程 TCP 集成测试
 *
 * 启动 3 个子进程，每个使用 TcpTransport 通过 TCP 通信。
 * 验证 leader 选举、log replication、propose/broadcast、故障恢复。
 *
 * 子进程启动方式：npx tsx src/consensus/raft-test-node.ts
 * 通信方式：stdin/stdout JSON 行协议
 */
export {};
//# sourceMappingURL=raft-integration.spec.d.ts.map