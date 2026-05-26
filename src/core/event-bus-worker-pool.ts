/**
 * event-bus-worker-pool.ts — EventBusWorkerPool 多进程架构
 *
 * 将 ZMQ DEALER socket 管理分散到 N 个子进程，突破单事件循环处理上限。
 *
 * 架构:
 *   主进程 (EventBus)                    子进程 (worker-x)
 *   ┌─────────────────────┐             ┌─────────────────────┐
 *   │ ROUTER socket       │             │ DEALER (peer-a)     │────→ peer-a ROUTER
 *   │ (保留在主进程)       │             │ DEALER (peer-b)     │────→ peer-b ROUTER
 *   │                     │             │ DEALER (peer-c)     │────→ peer-c ROUTER
 *   │ WorkerPool          │───IPC──▶   │ ...                 │
 *   │   - consistencyhash │◀──IPC──   │ ACK receive loop    │
 *   │   - send(peer,msg)  │             └─────────────────────┘
 *   │   - getStats()      │
 *   └─────────────────────┘
 *
 * 关键设计:
 *   1. 一致性 hash 保证同一 peer 始终分配到同一 worker
 *   2. 子进程独立 ZMQ Context，避免 fork() 后 zmq context 崩溃
 *   3. ACK 通过 IPC 回传主进程，主进程写入 LMDB (markAcked)
 *   4. 子进程通过 LMDB mmap 只读读取 ACK 状态（零 IPC 延迟）
 *   5. child_process.fork() 提供内置 IPC channel
 */

import * as child_process from 'node:child_process'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import type { TransportMessage } from './event-bus'
import { Logger } from '../ops/logger'

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** Peer 配置（与 EventBus 中的 PeerDescriptor 一致） */
export interface PeerConfig {
  nodeId: string
  port: number
  address: string
}

/** Worker 状态 */
export interface WorkerStats {
  pid: number | null
  peerIds: string[]
  dealerCount: number
  totalSent: number
  uptimeMs: number
  running: boolean
}

/** WorkerPool 统计 */
export interface WorkerPoolStats {
  workers: WorkerStats[]
  totalWorkers: number
  totalPeers: number
  totalSent: number
}

/** IPC 消息：主进程 → 子进程 */
interface PoolToWorkerMsg {
  type: 'start' | 'send' | 'shutdown' | 'getStats'
  peerIds?: string[]
  curveDir?: string
  basePort?: number
  peerId?: string
  msgs?: TransportMessage[]
  requestId?: string
}

/** IPC 消息：子进程 → 主进程 */
interface WorkerToPoolMsg {
  type: 'ready' | 'sent' | 'ack' | 'error' | 'stats' | 'shutdown'
  peerId?: string
  count?: number
  msgId?: string
  message?: string
  pid?: number
  requestId?: string
  stats?: any
  dealerCount?: number
  peerIds?: string[]
  /** 是否为初始就绪信号（区分 Phase 1 和 Phase 2） */
  initial?: boolean
}

// ---------------------------------------------------------------------------
// 一致性 hash（基于 CRC32 的简单实现）
// ---------------------------------------------------------------------------

/**
 * 简单一致性 hash 实现。
 * 将 peerId 映射到 [0, ringSize) 环上的一个点，
 * 然后顺时针分配到最近的 worker 节点。
 * 当 worker 数变化时，只有部分 peer 的分配会改变。
 */
class ConsistentHash {
  private ringSize: number
  private ring: Array<{ hash: number; workerIndex: number }> = []
  private workerCount = 0

  constructor(ringSize = 256) {
    this.ringSize = ringSize
  }

  /** 更新 worker 节点数 */
  updateWorkers(count: number): void {
    this.workerCount = count
    this.ring = []

    // 为每个 worker 生成多个虚拟节点（提高平衡性）
    const virtualNodes = count * 8
    for (let i = 0; i < virtualNodes; i++) {
      const workerIndex = i % count
      const key = `worker-${workerIndex}-vnode-${Math.floor(i / count)}`
      const hash = this._hash(key) % this.ringSize
      this.ring.push({ hash, workerIndex })
    }

    // 按 hash 值排序
    this.ring.sort((a, b) => a.hash - b.hash)
  }

  /** 获取 peerId 对应的 worker 索引 */
  getWorkerIndex(peerId: string): number {
    if (this.workerCount === 0) return 0
    const hash = this._hash(peerId) % this.ringSize

    // 二分查找第一个 hash >= target 的节点
    let lo = 0
    let hi = this.ring.length - 1
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (this.ring[mid].hash >= hash) {
        hi = mid
      } else {
        lo = mid + 1
      }
    }

    // 如果没找到（环形），取第一个
    if (this.ring[lo].hash < hash) {
      return this.ring[0].workerIndex
    }
    return this.ring[lo].workerIndex
  }

  /** 工作节点数 */
  get count(): number {
    return this.workerCount
  }

  /** CRC32 hash */
  private _hash(str: string): number {
    let crc = 0xFFFFFFFF
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      crc ^= char
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0)
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0
  }
}

// ---------------------------------------------------------------------------
// EventBusWorkerPool
// ---------------------------------------------------------------------------

export class EventBusWorkerPool {
  /** 子进程列表 */
  private workers: Array<{
    process: child_process.ChildProcess | null
    peerIds: string[]
    ready: boolean
  }> = []

  /** 一致性 hash 分配器 */
  private hashRing: ConsistentHash

  /** CURVE 密钥目录（传递给子进程） */
  private curveDir: string = ''
  /** 本机 ROUTER 基础端口 */
  private basePort: number = 5555

  /** ACK 回调（主进程注册，收到子进程 ACK 时调用） */
  private ackCallback: ((peerId: string, msgId: string) => void) | null = null

  /** WorkerPool 是否运行中 */
  private running = false

  /** 子进程数量 */
  private concurrency = 0

  private log: Logger
  private _requestCounter = 0

  constructor() {
    this.hashRing = new ConsistentHash()
    this.log = new Logger('EventBusWorkerPool')
  }

  // ── 生命周期 ──

  /**
   * 启动 WorkerPool
   *
   * fork N 个子进程，按一致性 hash 分配 peer，
   * 等所有子进程就绪后 resolve。
   */
  async start(
    peers: PeerConfig[],
    concurrency: number,
    options?: {
      curveDir?: string
      basePort?: number
      ackCallback?: (peerId: string, msgId: string) => void
    },
  ): Promise<void> {
    if (this.running) {
      this.log.warn('WorkerPool already running')
      return
    }

    this.running = true
    this.concurrency = concurrency
    this.curveDir = options?.curveDir ?? ''
    this.basePort = options?.basePort ?? 5555
    if (options?.ackCallback) {
      this.ackCallback = options.ackCallback
    }

    if (concurrency <= 0) {
      this.log.warn('WorkerPool concurrency must be > 0, defaulting to 1')
      concurrency = 1
      this.concurrency = 1
    }

    // 1. 更新 hash ring
    this.hashRing.updateWorkers(concurrency)

    // 2. 分配 peer
    const peerAllocations: string[][] = Array.from({ length: concurrency }, () => [])
    for (const peer of peers) {
      const idx = this.hashRing.getWorkerIndex(peer.nodeId)
      peerAllocations[idx].push(peer.nodeId)
    }

    // 3. fork 子进程
    const forkPromises: Array<Promise<void>> = []
    for (let i = 0; i < concurrency; i++) {
      const peerIds = peerAllocations[i]
      forkPromises.push(this._forkWorker(i, peerIds))
    }

    // 等待所有子进程就绪
    await Promise.all(forkPromises)
    this.log.info(`WorkerPool started with ${concurrency} workers, ${peers.length} peers`)
  }

  /**
   * 停止 WorkerPool：发送 shutdown 给所有子进程，等待退出
   */
  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false

    const stopPromises = this.workers.map(async (worker, idx) => {
      if (!worker.process || !worker.ready) return
      return new Promise<void>((resolve) => {
        const proc = worker.process!
        // 发送 shutdown
        try {
          proc.send({ type: 'shutdown' } as any)
        } catch { /* ignore */ }

        // 最多等待 3 秒
        const timeout = setTimeout(() => {
          try { proc.kill('SIGKILL') } catch { /* ignore */ }
          resolve()
        }, 3000)

        proc.on('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    })

    await Promise.all(stopPromises)
    this.workers = []
    this.log.info('WorkerPool stopped')
  }

  /**
   * 重新分配：停旧启新
   * 当 peer 列表发生变化时调用。
   */
  async rebalance(newPeers: PeerConfig[]): Promise<void> {
    if (!this.running) return

    await this.stop()
    await this.start(newPeers, this.concurrency, {
      curveDir: this.curveDir,
      basePort: this.basePort,
      ackCallback: this.ackCallback ?? undefined,
    })
  }

  // ── 消息发送 ──

  /**
   * 发送消息到指定 peer
   * 按一致性 hash 路由到对应 worker
   */
  async send(peerId: string, msgs: TransportMessage[]): Promise<void> {
    if (!this.running || this.workers.length === 0) {
      this.log.warn(`send: WorkerPool not running`)
      return
    }

    const workerIdx = this.hashRing.getWorkerIndex(peerId)
    const worker = this.workers[workerIdx]
    if (!worker || !worker.process || !worker.ready) {
      this.log.warn(`send: worker ${workerIdx} not ready`)
      return
    }

    try {
      worker.process.send({
        type: 'send',
        peerId,
        msgs,
      } as PoolToWorkerMsg)
    } catch (err: any) {
      this.log.warn(`send to worker ${workerIdx} for peer ${peerId} failed: ${err.message}`)
    }
  }

  // ── 统计 & 状态 ──

  /**
   * 获取所有 worker 的状态
   */
  getStats(): WorkerPoolStats {
    const workerStats: WorkerStats[] = this.workers.map((w, idx) => ({
      pid: w.process?.pid ?? null,
      peerIds: w.peerIds,
      dealerCount: w.peerIds.length,
      totalSent: 0,
      uptimeMs: 0,
      running: w.ready && this.running && w.process !== null && !w.process.killed,
    }))

    return {
      workers: workerStats,
      totalWorkers: this.workers.length,
      totalPeers: this.workers.reduce((acc, w) => acc + w.peerIds.length, 0),
      totalSent: 0,
    }
  }

  /** 获取一致性 hash 路由信息（调试用） */
  getRoutingMap(): Map<string, number> {
    const routing = new Map<string, number>()
    for (const [idx, worker] of this.workers.entries()) {
      for (const peerId of worker.peerIds) {
        routing.set(peerId, idx)
      }
    }
    return routing
  }

  // ── 内部方法 ──

  /**
   * fork 一个子进程，分配 peerId 列表
   */
  private async _forkWorker(workerIndex: number, peerIds: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // 子进程文件路径
      const workerScript = path.resolve(__dirname, 'event-bus-worker-process.ts')
      // 使用 ts-node 运行 TypeScript 子进程
      const child = child_process.fork(workerScript, [], {
        execArgv: ['-r', 'ts-node/register'],
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: {
          ...process.env,
          WORKER_INDEX: String(workerIndex),
        },
      })

      const workerEntry: (typeof this.workers)[0] = {
        process: child,
        peerIds: [],
        ready: false,
      }
      this.workers[workerIndex] = workerEntry

      // 两阶段就绪：
      // Phase 1: 子进程启动后发送 initial ready → 主进程发送 start 指令（含 peerIds）
      // Phase 2: 子进程创建完 DEALER 后发送 second ready → 主进程标记就绪并 resolve
      let phase = 0

      child.on('message', (msg: any) => {
        try {
          const data: WorkerToPoolMsg = msg
          switch (data.type) {
            case 'ready': {
              if (phase === 0) {
                // Phase 1: 子进程初始就绪 → 发送 start 指令
                phase = 1
                child.send({
                  type: 'start',
                  peerIds,
                  curveDir: this.curveDir,
                  basePort: this.basePort,
                } as PoolToWorkerMsg)
              } else if (phase === 1 && data.initial === undefined) {
                // Phase 2: 子进程完成 start 后再次回复 ready
                phase = 2
                workerEntry.ready = true
                workerEntry.peerIds = peerIds
                this.log.info(
                  `Worker ${workerIndex} ready (pid=${child.pid}, ${peerIds.length} peers)`,
                )
                resolve()
              }
              break
            }

            case 'sent':
              // 发送完成通知
              if (data.peerId && data.count !== undefined) {
                this.log.debug(`Worker ${workerIndex}: sent ${data.count} msg(s) to ${data.peerId}`)
              }
              break

            case 'ack':
              // 子进程收到 ACK，回传主进程
              if (data.peerId && data.msgId && this.ackCallback) {
                this.ackCallback(data.peerId, data.msgId)
              }
              break

            case 'error':
              this.log.warn(`Worker ${workerIndex} error: ${data.message}`)
              break

            case 'stats':
              // 统计查询响应
              break
          }
        } catch { /* ignore malformed IPC */ }
      })

      child.on('error', (err) => {
        this.log.warn(`Worker ${workerIndex} error: ${err.message}`)
        workerEntry.ready = false
        if (phase === 0) reject(err)
      })

      child.on('exit', (code) => {
        this.log.info(`Worker ${workerIndex} exited (code=${code})`)
        workerEntry.ready = false
        workerEntry.process = null
      })
    })
  }
}
