/**
 * raft-test-node.ts — Raft 跨进程集成测试子进程
 *
 * 通过 stdin JSON 行协议接收命令，stdout 返回结果。
 *
 * 启动：npx tsx src/consensus/raft-test-node.ts
 * 环境变量：
 *   RT_NODE_ID — 节点 ID
 *   RT_PEERS  — JSON: ["2:127.0.0.1:17551", "3:127.0.0.1:17552"]
 *   RT_PORT   — TCP 监听端口
 *   RT_DATA_DIR — 数据目录
 */
export {};
//# sourceMappingURL=raft-test-node.d.ts.map