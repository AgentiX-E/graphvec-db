/**
 * event-bus-worker-process.ts — EventBus WorkerPool 子进程入口
 *
 * 每个子进程独立管理一组 ZMQ DEALER socket（通过一致性 hash 分配）。
 * 通过 Node.js IPC channel 与主进程通信。
 *
 * 子进程生命周期：
 *   1. 收到 `{ type: 'start', peerIds, curveDir, basePort, ... }` → 创建 DEALER 连接到对应地址
 *   2. 收到 `{ type: 'send', peerId, msgs }` → ZMQ DEALER send (batchSend)
 *   3. 收到 `{ type: 'shutdown' }` → 关闭所有 DEALER，优雅退出
 *
 * ACK 处理：
 *   - DEALER 收到 ACK 回复帧 → 通过 IPC 回传 `{ type: 'ack', peerId, msgId }`
 *   - LMDB mmap 已由 outbox-replication.ts 的 Outbox 写入，子进程可只读打开
 *   - 子进程通过 `open() + isAcked(seq)` 零 IPC 延迟读取 ACK 状态
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const zmq = require('zeromq')
import type { TransportMessage } from './event-bus'
import { Logger } from '../ops/logger'

/** ZMQ Dealer 类型的本地接口——用于子进程中的 DEALER socket */
interface ZMQDealer {
  connect: (addr: string) => Promise<void>
  close: () => void
  send: (frames: Buffer[], flags?: number) => Promise<void>
  receive: () => Promise<Buffer[]>
  readonly closed: boolean
}

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** IPC 主进程 → 子进程命令 */
interface WorkerCommand {
  type: 'start' | 'send' | 'shutdown' | 'getStats'
  /** start: 分配的 peer ID 列表 */
  peerIds?: string[]
  /** start: CURVE 密钥存储目录 */
  curveDir?: string
  /** start: 本机 ROUTER 基础端口（用于构建 peer 地址） */
  basePort?: number
  /** send: 目标 peer ID */
  peerId?: string
  /** send: 要发送的消息数组 */
  msgs?: TransportMessage[]
  /** 统计查询请求 ID（用于响应） */
  requestId?: string
}

/** IPC 子进程 → 主进程响应 */
interface WorkerResponse {
  type: 'ready' | 'sent' | 'ack' | 'error' | 'stats' | 'shutdown'
  /** sent/ack: 目标 peer ID */
  peerId?: string
  /** sent: 成功发送的消息数 */
  count?: number
  /** ack: 被确认的消息 ID */
  msgId?: string
  /** error: 错误消息 */
  message?: string
  /** stats: 子进程统计信息 */
  stats?: WorkerStats
  /** 响应请求 ID */
  requestId?: string
}

/** 子进程统计 */
interface WorkerStats {
  peerIds: string[]
  dealerCount: number
  totalSent: number
  uptimeMs: number
}

// ---------------------------------------------------------------------------
// WorkerProcess 类
// ---------------------------------------------------------------------------

class WorkerProcess {
  /** peerId → ZMQ DEALER socket */
  private dealers = new Map<string, ZMQDealer>()
  /** 分配的 peer ID 列表 */
  private peerIds: string[] = []
  /** CURVE 公钥目录路径 */
  private curveDir: string = ''
  /** 本机 ROUTER 基础端口 */
  private basePort: number = 0
  /** 子进程是否运行中 */
  private running = false
  /** 累计成功发送消息数 */
  private totalSent = 0
  /** 启动时间 */
  private startTime = 0
  /** ZMQ_SENDMORE 常量（如果版本支持） */
  private readonly ZMQ_SENDMORE: number | undefined = typeof zmq.ZMQ_SENDMORE === 'number' ? zmq.ZMQ_SENDMORE : undefined

  private log: Logger

  constructor() {
    // 使用 worker-[pid] 作为 logger tag
    this.log = new Logger(`worker-${process.pid}`)
  }

  // ── IPC 消息处理入口 ──

  /**
   * 处理来自主进程的 IPC 命令。
   * 通过 process.on('message') 注册回调。
   */
  async handleCommand(cmd: WorkerCommand): Promise<void> {
    switch (cmd.type) {
      case 'start':
        await this._handleStart(cmd)
        break
      case 'send':
        await this._handleSend(cmd)
        break
      case 'shutdown':
        await this._handleShutdown()
        break
      case 'getStats':
        this._handleGetStats(cmd)
        break
      default:
        // 未知命令，忽略
        break
    }
  }

  // ── 命令处理 ──

  /**
   * start: 为每个分配的 peerId 创建 ZMQ DEALER socket 并连接
   */
  private async _handleStart(cmd: WorkerCommand): Promise<void> {
    const peerIds = cmd.peerIds ?? []
    const curveDir = cmd.curveDir ?? ''
    const basePort = cmd.basePort ?? 5555

    this.peerIds = peerIds
    this.curveDir = curveDir
    this.basePort = basePort
    this.running = true
    this.startTime = Date.now()

    // 为每个 peer 创建 DEALER
    for (const peerId of peerIds) {
      try {
        const dealer: ZMQDealer = new zmq.Dealer()
        // 解析 peer 的端口号（从 peerId 中提取序号，用于计算端口）
        const idx = this._parsePeerIndex(peerId)
        const port = basePort + idx
        const addr = `tcp://127.0.0.1:${port}`
        await dealer.connect(addr)
        this.dealers.set(peerId, dealer)
        this.log.info(`DEALER connected to ${addr} (peer: ${peerId})`)
      } catch (err: any) {
        this.log.warn(`DEALER connect failed for ${peerId}: ${err.message}`)
        // 继续连接其他 peer
      }
    }

    // 启动 DEALER 接收循环（接收 ACK 或其他回复）
    this._startDealerReceiveLoop()

    // 回复主进程就绪（Phase 2 ready — 告知主进程所有 DEALER 已创建）
    this._send({
      type: 'ready',
      peerIds: this.peerIds,
      dealerCount: this.dealers.size,
    } as any)
  }

  /**
   * send: 发送消息到指定 peer
   * 支持批量发送（ZMQ multi-part 帧序列提高吞吐量）
   */
  private async _handleSend(cmd: WorkerCommand): Promise<void> {
    const peerId = cmd.peerId
    const msgs = cmd.msgs ?? []

    if (!peerId) {
      this._send({ type: 'error', message: 'send command missing peerId' })
      return
    }

    const dealer = this.dealers.get(peerId)
    if (!dealer) {
      this.log.warn(`send: no DEALER for peer ${peerId}`)
      this._send({ type: 'error', peerId, message: `no DEALER for peer ${peerId}` })
      return
    }

    try {
      // 批量发送：使用 ZMQ multi-part 帧序列
      if (msgs.length > 1) {
        for (let i = 0; i < msgs.length; i++) {
          const payload = Buffer.from(JSON.stringify(msgs[i]))
          if (i < msgs.length - 1) {
            await dealer.send([payload], this.ZMQ_SENDMORE)
          } else {
            await dealer.send([payload])
          }
        }
      } else if (msgs.length === 1) {
        const payload = Buffer.from(JSON.stringify(msgs[0]))
        await dealer.send([payload])
      }

      this.totalSent += msgs.length
      this._send({
        type: 'sent',
        peerId,
        count: msgs.length,
      })
    } catch (err: any) {
      this.log.warn(`send to ${peerId} error: ${err.message}`)
      this._send({
        type: 'error',
        peerId,
        message: err.message,
      })
    }
  }

  /**
   * shutdown: 优雅关闭所有 DEALER socket 并退出
   */
  private async _handleShutdown(): Promise<void> {
    this.running = false
    this.log.info(`shutting down ${this.dealers.size} DEALER(s)`)

    // 关闭所有 DEALER
    for (const [peerId, dealer] of this.dealers) {
      try {
        dealer.close()
      } catch { /* best-effort */ }
    }
    this.dealers.clear()

    this._send({ type: 'shutdown' })
    process.exit(0)
  }

  /**
   * getStats: 返回子进程统计信息
   */
  private _handleGetStats(cmd: WorkerCommand): void {
    this._send({
      type: 'stats',
      requestId: cmd.requestId,
      stats: {
        peerIds: this.peerIds,
        dealerCount: this.dealers.size,
        totalSent: this.totalSent,
        uptimeMs: Date.now() - this.startTime,
      },
    })
  }

  // ── 辅助方法 ──

  /**
   * 启动 DEALER 接收循环。
   * 子进程的 DEALER socket 不仅要 send，还要 receive（接收 ACK 回复）。
   */
  private _startDealerReceiveLoop(): void {
    // DEALER 在 ZMQ 架构中是一对一的 client socket，
    // 通过 dealer.receive() 阻塞等待对方 ROUTER 回复。
    // 我们为每个 DEALER 启动独立的接收协程。
    for (const [peerId, dealer] of this.dealers) {
      this._startSingleDealerReceive(peerId, dealer)
    }
  }

  private async _startSingleDealerReceive(peerId: string, dealer: ZMQDealer): Promise<void> {
    while (this.running) {
      try {
        const frames = await dealer.receive()
        if (!this.running) break
        if (!frames || frames.length === 0) continue

        // 最后一帧是 JSON 负载
        const payload = frames[frames.length - 1]
        const text = Buffer.from(payload).toString('utf-8')
        let msg: TransportMessage
        try {
          msg = JSON.parse(text)
        } catch {
          continue
        }

        // 处理 ACK
        if (msg.type === 'ack' && msg.ackMsgId) {
          this._send({
            type: 'ack',
            peerId,
            msgId: msg.ackMsgId,
          })
        }
      } catch (err: any) {
        if (!this.running) break
        // 接收错误通常意味着 socket 已关闭
        break
      }
    }
  }

  /**
   * 从 peerId 中解析序号索引（如 "node-1" → 1, "peer-2" → 2）
   * 用于计算 ZMQ 端口。
   */
  private _parsePeerIndex(peerId: string): number {
    const match = peerId.match(/(\d+)$/)
    if (match) {
      return parseInt(match[1], 10)
    }
    // 退避：使用 hash
    let hash = 0
    for (let i = 0; i < peerId.length; i++) {
      hash = ((hash << 5) - hash) + peerId.charCodeAt(i)
      hash |= 0
    }
    return Math.abs(hash) % 100
  }

  /**
   * 通过 IPC 向主进程发送消息
   */
  private _send(response: WorkerResponse & Record<string, unknown>): void {
    try {
      if (process.send) {
        process.send(response)
      }
    } catch {
      // IPC channel 可能已关闭
    }
  }
}

// ---------------------------------------------------------------------------
// 子进程入口
// ---------------------------------------------------------------------------

const worker = new WorkerProcess()

// 注册 IPC 消息处理
process.on('message', (cmd: WorkerCommand) => {
  worker.handleCommand(cmd).catch((err: Error) => {
    try {
      if (process.send) {
        process.send({ type: 'error', message: `unhandled: ${err.message}` })
      }
    } catch { /* ignore */ }
  })
})

// 父进程断开连接时退出
process.on('disconnect', () => {
  process.exit(0)
})

// SIGTERM/SIGINT 优雅退出
process.on('SIGTERM', () => {
  worker.handleCommand({ type: 'shutdown' }).catch(() => process.exit(1))
})
process.on('SIGINT', () => {
  worker.handleCommand({ type: 'shutdown' }).catch(() => process.exit(1))
})

// 通知父进程已启动（初始就绪信号）
if (process.send) {
  process.send({ type: 'ready', pid: process.pid, initial: true })
}
