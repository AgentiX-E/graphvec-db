/**
 * multi-leader-test-node.ts — Multi-Leader 集成测试子进程
 *
 * 通过 `npx tsx ...` 启动，通过 stdin（JSON line）接收命令，
 * 通过 stdout（JSON line）返回结果。
 *
 * 环境变量:
 *   ML_NODE_ID          — Node ID（如 node-1）
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
import { initEventBus, EventBus } from './event-bus'
import { MultiLeaderReplication } from './multi-leader-replication'
import { HlcClock } from '../replication/hlc-clock'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as readline from 'node:readline'
import { Logger } from '../ops/logger'

const logger = new Logger('MultiLeaderTestNode')

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

  // ── 读取额外的环境变量 ──
  const workerPoolConcurrency = parseInt(process.env.ML_WORKER_POOL_CONCURRENCY ?? '0', 10)
  const usePerPeerDb = process.env.ML_USE_PER_PEER_DB === 'true'
  const tickMs = parseInt(process.env.ML_TICK_MS ?? '500', 10)
  const batchSize = parseInt(process.env.ML_BATCH_SIZE ?? '1', 10)

  // ── 初始化 EventBus（NAS 模式：自动发现 peer） ──
  const bus = await initEventBus({
    nodeId,
    port,
    security: {
      curve: {
        nodeId,
        port,
        server: true,
        publicKeyDir: curveDir,
      },
    },
  })

  // ── 如果配置了 WorkerPool，在 EventBus 上设置 WorkerPool ──
  if (workerPoolConcurrency > 0) {
    const { EventBusWorkerPool } = await import('./event-bus-worker-pool')
    const workerPool = new EventBusWorkerPool()
    const peersList = peers
      .filter((pid: string) => pid !== nodeId)
      .map((pid: string) => {
        const pIdx = parseInt(pid.split('-')[1], 10)
        return { nodeId: pid, port: port + pIdx - 1, address: `tcp://127.0.0.1:${port + pIdx - 1}` }
      })
    await workerPool.start(peersList, workerPoolConcurrency, {
      curveDir,
      basePort: port,
      ackCallback: (peerId: string, msgId: string) => {
        // 收到 ACK 时调用 replication 的 notifyAcked
      },
    })
    ;(bus as EventBus).workerPool = workerPool
    logger.info(`WorkerPool configured with concurrency=${workerPoolConcurrency}`)
  }

  // ── 确保所有 DEALER 连接建立后再发送就绪信号 ──
  // 不重试：NAS 模式下顺序启动的第一个节点看不到任何 peer 公钥是正常的。
  // 后续节点的 DEALER 会连接到此节点的 ROUTER。
  const dealerCount = (bus as EventBus as any).getPeerNodeIds?.()?.length ?? 0

  // ── 初始化 HLC ──
  const clock = new HlcClock()

  // ── 初始化 EventStream ──
  const es = new EventStream({
    nodeId,
    eventBus: bus,
    walDir: path.join(dataDir, 'wal.bin'),
  })
  es.open()

  // 注册 ACK 回调：收到 ACK 时通知 Outbox 的 ackTracker（驱动 Outbox pending drain）
  es.registerOnAck((peerId: string, msgId: string) => {
    replication.notifyAcked(peerId)
  })

  // ── 初始化 Multi-Leader 复制层 ──
  const peersWithAddr = peers.map((pid: string) => {
    const pIdx = parseInt(pid.split('-')[1], 10)
    return { nodeId: pid, addr: `tcp://127.0.0.1:${port + pIdx - 1}` }
  })
  const replication = new MultiLeaderReplication({
    nodeId,
    peers: peersWithAddr,
    curveDir,
    dbPath: path.join(dataDir, 'outbox.lmdb'),
    eventBus: bus as any,
    maxBackoffSeconds: 3, // 测试环境退避更快
    tickMs,
    batchSize,
    usePerPeerDb,
  })
  replication.start()

  // ── 初始化 GraphEngine ──
  const engine = new GraphEngine(
    { path: dataDir },
    new OverGraphStorage(),
    es,
    replication,
  )
  engine.open()

  logOut({ type: 'status', nodeId, peers: (bus as any).dealerSockets ? [...(bus as any).dealerSockets.keys()] : [] })
  logOut({ type: 'ready', nodeId, dealerCount })

  // ── 监听 stdin 命令 ──
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on('line', async (line) => {
    try {
      const msg = JSON.parse(line)
      if (!msg || !msg.type) return

      switch (msg.type) {
        case 'upsertNode': {
          try {
            const opts: any = { props: msg.payload.props }
            const id = await engine.upsertNode(msg.payload.typeId, msg.payload.name, opts)
            logOut({ type: 'writeResult', success: true, nodeId: id, name: msg.payload.name })
          } catch (err: any) {
            logOut({ type: 'writeResult', success: false, error: err.message })
          }
          break
        }
        case 'upsertEdge': {
          try {
            const src: string = msg.payload.from ?? ''
            const dst: string = msg.payload.to ?? ''
            const typeId: number = Number(msg.payload.edgeType ?? 0)
            const edgeOpts: any = {}
            if (msg.payload.props) edgeOpts.props = msg.payload.props
            // @ts-expect-error — TS incorrectly resolves typeId as string
            await engine.upsertEdge(src, dst, typeId, edgeOpts)
            logOut({ type: 'edgeResult', success: true })
          } catch (err: any) {
            logOut({ type: 'edgeResult', success: false, error: err.message })
          }
          break
        }
        case 'batchUpsertNode': {
          try {
            const items: Array<{ typeId: number; name: string; props?: Record<string, unknown> }> = msg.payload.items ?? []
            const ids: string[] = []
            const names: string[] = []
            for (const item of items) {
              const typeIdNum = Number(item.typeId)
              const id = await engine.upsertNode(typeIdNum, item.name, { props: (item.props ?? {}) as any })
              // @ts-expect-error — TS incorrectly resolves id as number
              ids.push(id)
              names.push(item.name)
            }
            logOut({ type: 'batchResult', success: true, ids, names })
          } catch (err: any) {
            logOut({ type: 'batchResult', success: false, error: err.message })
          }
          break
        }
        case 'getNode': {
          const node = engine.getNode(msg.payload.id)
          logOut({ type: 'getNodeResult', node: node ? { ...node } : null })
          break
        }
        case 'getDealerStatus': {
          let cnt = (bus as any).getPeerNodeIds?.()?.length ?? 0
          // WorkerPool 模式下 DEALER 在子进程中，通过 WorkerPool 统计总 DEALER 数
          const wp = (bus as EventBus).workerPool
          if (wp) {
            const stats = wp.getStats()
            const totalDealers = stats.workers.reduce((sum: number, w: any) => sum + (w.peerIds?.length ?? 0), 0)
            if (totalDealers > cnt) cnt = totalDealers
          }
          logOut({ type: 'dealerStatus', dealerCount: cnt })
          break
        }
        case 'getOutboxStats': {
          const stats = replication.getStats()
          logOut({ type: 'outboxStats', pending: stats.pending, workers: stats.workers })
          break
        }
        case 'getWorkerPoolStats': {
          const wp = (bus as EventBus).workerPool
          const wStats = wp ? wp.getStats() : null
          logOut({ type: 'workerPoolStats', stats: wStats })
          break
        }
        case 'getPeerReports': {
          logOut({ type: 'peerReports', reports: (replication as any).manager?.getPeerReports?.() ?? [] })
          break
        }
        case 'updateConfig': {
          try {
            const partial = msg.payload ?? {}
            ;(replication as any).manager?.updateConfig?.(partial)
            logOut({ type: 'configUpdated', partial })
          } catch (err: any) {
            logOut({ type: 'configUpdated', success: false, error: err.message })
          }
          break
        }
        case 'killWorkerPoolWorker': {
          const wp = (bus as EventBus).workerPool
          if (wp) {
            const stats = wp.getStats()
            const targetIdx = msg.payload?.workerIndex
            const worker = typeof targetIdx === 'number' ? stats.workers[targetIdx] : stats.workers[0]
            if (worker?.pid) {
              try {
                process.kill(worker.pid, 'SIGKILL')
                logOut({ type: 'killResult', success: true, killedPid: worker.pid })
              } catch (e: any) {
                logOut({ type: 'killResult', success: false, error: e.message })
              }
            } else {
              logOut({ type: 'killResult', success: false, error: 'no worker pid' })
            }
          } else {
            logOut({ type: 'killResult', success: false, error: 'no workerPool' })
          }
          break
        }
        case 'getLog': {
          logOut({ type: 'log', msg: 'check' })
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
  logger.error(`Fatal:`, err)
  process.exit(1)
})
