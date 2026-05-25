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

import { GraphEngine } from './graph-engine'
import { EventStream } from './event-stream'
import { OverGraphStorage } from './overgraph-storage'
import { initEventBus } from './event-bus'
import { MultiLeaderReplication } from './multi-leader-replication'
import { HlcClock } from '../replication/hlc-clock'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as readline from 'node:readline'

function logOut(msg: unknown): void {
  const str = JSON.stringify(msg) + '\n'
  try {
    fs.writeSync(process.stdout.fd, str)
  } catch {
    // stdio already closed, ignore
  }
}

async function main() {
  const nodeId = process.env.ML_NODE_ID!
  const peers: string[] = JSON.parse(process.env.ML_PEERS!)
  const port = parseInt(process.env.ML_PORT!, 10)
  const dataDir = process.env.ML_DATA_DIR!
  const curveDir = process.env.ML_CURVE_DIR!

  // ── 初始化 EventBus（NAS 模式：自动发现 peer） ──
  const bus = await initEventBus({
    nodeId,
    port,
    security: {
      curve: {
        mode: 'nas',
        nodeId,
        port,
        server: true,
        publicKeyDir: curveDir,
      },
    },
  })

  // ── 初始化 HLC ──
  const clock = new HlcClock()

  // ── 初始化 EventStream ──
  const es = new EventStream({
    nodeId,
    eventBus: bus,
    walDir: path.join(dataDir, 'wal.bin'),
  })
  es.open()

  // ── 初始化 Multi-Leader 复制层 ──
  const replication = new MultiLeaderReplication({
    nodeId,
    peers,
    eventStream: es,
    clock,
    syncTimeoutMs: 5000,
  })

  // ── 初始化 GraphEngine ──
  const engine = new GraphEngine(
    { path: dataDir },
    new OverGraphStorage(),
    es,
    replication,
  )
  engine.open()

  // ── 发送就绪信号 ──
  logOut({ type: 'ready', nodeId })

  // ── 监听 stdin 命令 ──
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on('line', async (line) => {
    try {
      const msg = JSON.parse(line)
      if (!msg || !msg.type) return

      switch (msg.type) {
        case 'upsertNode': {
          try {
            const id = await engine.upsertNode(msg.payload.typeId, msg.payload.name, { props: msg.payload.props })
            logOut({ type: 'writeResult', success: true, nodeId: id })
          } catch (err: any) {
            logOut({ type: 'writeResult', success: false, error: err.message })
          }
          break
        }
        case 'getNode': {
          const node = engine.getNode(msg.payload.id)
          logOut({ type: 'getNodeResult', node: node ? { ...node } : null })
          break
        }
        default:
          // ignore
      }
    } catch {
      // ignore malformed JSON
    }
  })
}

main().catch(err => {
  console.error(`[${process.env.ML_NODE_ID}] Fatal:`, err)
  process.exit(1)
})
