/**
 * multi-leader-test-node.ts — Multi-Leader 集成测试子进程
 *
 * 通过 `npx tsx ...` 启动，通过 stdin（JSON line）接收命令，
 * 通过 stdout（JSON line）返回结果。
 *
 * 环境变量:
 *   ML_NODE_ID          — 节点 ID（如 node-1）
 *   ML_PEERS            — JSON 数组: ["node-1","node-2","node-3"]
 *   ML_PORT             — ZMQ 端口
 *   ML_DATA_DIR         — WAL / 数据目录
 *   ML_CURVE_DIR        — NAS 公钥共享目录
 *
 * NAS 模式自动发现 peer，不需要传地址列表。
 */
export {};
//# sourceMappingURL=multi-leader-test-node.d.ts.map