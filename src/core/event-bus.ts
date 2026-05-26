/**
 * Distributed EventBus — ZeroMQ ROUTER/DEALER 分布式事件总线
 *
 * 架构:
 *   GraphEngine emit() → EventStream → EventBus
 *                                     ├── Local EventEmitter (本进程即刻响应)
 *                                     └── DEALER socket → ROUTER on each peer (点对点)
 *
 *   每个节点持有：
 *     - 1 个 ROUTER socket（Server）：接收所有 peer 发来的消息
 *     - N 个 DEALER socket：每个远程节点一个，定向发送消息
 *
 * 安全:
 *   CURVE (Curve25519) 双向认证 + 传输加密。
 *   支持 NAS 共享目录自动分发公钥。
 *
 * 消息协议：
 *   所有消息带 msgId + type，接收方点对点回 ACK。
 *   消息类型：
 *     - 'data'            : 普通数据事件（节点创建/删除等）
 *     - 'ack'             : 确认回执
 *     - 'sync-query'      : 询问对方最新 seq
 *     - 'sync-query-reply': 回复自己的最新 seq
 *     - 'sync-request'    : 请求从某 seq 开始的数据
 *     - 'sync-batch'      : 批量历史事件回复
 */

import { EventEmitter } from 'node:events'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const zmq = require('zeromq')
import { Logger } from '../ops/logger'
type Router = any
type Dealer = any
import * as fs from 'node:fs'
import * as path from 'node:path'
import { EventBusWorkerPool, type PeerConfig } from './event-bus-worker-pool'

// ──────────────────────────────────────────
// 事件类型
// ──────────────────────────────────────────

export type GraphEventType =
  | 'node:created' | 'node:updated' | 'node:deleted'
  | 'edge:created' | 'edge:updated' | 'edge:deleted'
  | 'backup:start' | 'backup:complete'
  | 'graph:cleared'
  // 远程节点加入/离开
  | 'cluster:node-joined' | 'cluster:node-left'
  | 'cluster:leader-changed'
  // 可靠事件流（EventStream）控制消息
  | 'event:ack'
  | 'event:sync'
  | 'event:sync-batch'
  // 系统事件
  | 'system:shutdown'

export interface GraphEvent {
  type: GraphEventType
  nodeId: string         // 来源节点 ID
  timestamp: number
  data: Record<string, unknown>
}

// ──────────────────────────────────────────
// CURVE 认证配置
// ──────────────────────────────────────────

/**
 * CURVE 密钥存储模式
 *
 * - `'explicit'` : 在配置中直接传入密钥字符串
 * - `'nas'`       : 通过 NAS 共享目录自动管理公钥
 */
/**
 * CURVE 强制启用，不可关闭。
 * 使用单一的 CurveSecurityConfig 配置，无需 mode 区分。
 */
/**
 * CURVE 安全配置
 *
 * CURVE 是 ZeroMQ 内置的 Curve25519 认证+加密机制。
 * 当前项目强制启用 CURVE，不可关闭。
 * - `server`: ROUTER 端 true，DEALER 端 false
 * - `publicKeyDir`: NAS 共享公钥目录路径
 * - `port`: 本节点 ROUTER 监听端口
 * - `nodeId`: 本节点唯一标识
 */
export interface CurveSecurityConfig {
  server: boolean
  publicKeyDir: string
  port: number
  nodeId: string
}

/**
 * 传输安全配置
 *
 * CURVE 强制启用，不可关闭。
 * `curve` 字段必须提供，不可为 undefined。
 */
export interface EventBusSecurity {
  curve: CurveSecurityConfig
}

/**
 * NAS 目录扫描结果：描述一个 peer 节点如何连接
 */
export interface PeerDescriptor {
  nodeId: string
  port: number
  address: string       // ZMQ 地址，如 "tcp://127.0.0.1:5555"
  publicKey: string
}

// ──────────────────────────────────────────
// EventBus 配置
// ──────────────────────────────────────────

export interface EventBusConfig {
  /** 本节点 ID（唯一标识） */
  nodeId: string
  /** ROUTER socket 监听地址（null = 不启动 server 端） */
  publishAddress?: string | null
  /** 远程 peer 的 ROUTER 地址列表（每个地址创建一个 DEALER） */
  subscribeAddresses?: string[]
  /** 本节点 ROUTER 端口（NAS 模式时需要） */
  port?: number
  /** 是否处于 Raft leader 角色（leader 不通过 ZMQ 收发事件） */
  isRaftLeader?: boolean
  /** CURVE 安全配置 */
  security?: EventBusSecurity
  /** NAS 目录动态监控间隔（ms），默认 3000。设为 0 禁用 */
  nasMonitorIntervalMs?: number
}

// ──────────────────────────────────────────
// 辅助：PUB 文件名管理（与旧版兼容，路由层不变）
// ──────────────────────────────────────────

/**
 * 根据 endpoint（nodeId + port）构建 CURVE 公钥文件名
 * 格式：`{nodeId}_{port}.pub`
 */
function publicKeyFileForEndpoint(nodeId: string, port: number): string {
  return `${nodeId}_${port}.pub`
}

/**
 * 从 `*.pub` 文件名解析 nodeId 和 port
 * 文件名格式：`{nodeId}_{port}.pub`
 */
export function parsePubFilename(filename: string): { nodeId: string; port: number } | null {
  const base = filename.endsWith('.pub') ? filename.slice(0, -4) : filename
  const lastUnderscore = base.lastIndexOf('_')
  if (lastUnderscore < 0) return null
  const nodeId = base.slice(0, lastUnderscore)
  const portStr = base.slice(lastUnderscore + 1)
  const port = parseInt(portStr, 10)
  if (isNaN(port) || port <= 0) return null
  return { nodeId, port }
}

/**
 * 从 NAS 目录读取指定 endpoint 的公钥
 */
function readPeerPublicKey(dir: string, nodeId: string, port: number): string | null {
  const filePath = path.join(dir, publicKeyFileForEndpoint(nodeId, port))
  try {
    const key = fs.readFileSync(filePath, 'utf-8').trim()
    return key.length > 0 ? key : null
  } catch {
    return null
  }
}

// ──────────────────────────────────────────
// ROUTER/DEALER 消息协议
// ──────────────────────────────────────────

/**
 * ROUTER/DEALER 传输的原始消息
 * 收发的都是 JSON 字符串（通过 ZMQ 多帧传输）
 */
export interface TransportMessage {
  /** 消息 ID（唯一，发送方分配） */
  msgId: string
  /** 消息类型 */
  type: 'data' | 'ack' | 'sync-query' | 'sync-query-reply' | 'sync-request' | 'sync-batch'
  /** 来源节点 ID */
  srcNodeId: string
  /** 目标节点 ID（data/ack/query 等可填 '' 表示广播关心） */
  dstNodeId?: string
  /** 负载数据 */
  data: Record<string, unknown>
  /** ACK 时指明被确认的原始消息 msgId */
  ackMsgId?: string
}

// ──────────────────────────────────────────
// EventBus 类
// ──────────────────────────────────────────

export class EventBus {
  private local = new EventEmitter()
  private config: EventBusConfig
  private routerSocket: Router | null = null
  /** 每个远程节点一个 DEALER socket，key = nodeId */
  private dealerSockets = new Map<string, Dealer>()
  /** ROUTER identity → nodeId 映射（收到消息时反向查找来源） */
  private identityToNode = new Map<string, string>()
  /** nodeId → ROUTER identity 映射（发送 ack 时需要 identity 定位 dealer） */
  private nodeToIdentity = new Map<string, string>()
  private running = false
  /** NAS 目录路径 */
  private nasKeyDir: string | null = null
  /** NAS 目录变更监控定时器（动态 DEALER 管理） */
  private _nasMonitorTimer: ReturnType<typeof setInterval> | null = null
  private nasKeyFiles: Set<string> | null = null
  private logger: Logger

  /**
   * 消息接收回调：EventStream 注册此回调处理收到的所有消息。
   * 参数：(msg: TransportMessage, fromNodeId: string)
   */
  private receiveHandler: ((msg: TransportMessage, fromNodeId: string) => void) | null = null

  /** 生产者/消费者缓冲：ROUTER receive 中原始帧入队 */
  private _routerBuffer: { msg: TransportMessage; fromNodeId: string }[] = []

  /** ACK msgId 批量积压队列 */
  private _ackBatchQueue: { ackMsgId: string; srcNodeId: string }[] = []

  /** ACK flush 定时器 */
  private _ackFlushTimer: NodeJS.Timeout | null = null

  /** ACK 批量 flush 阈值 */
  private readonly ACK_BATCH_SIZE = 20

  /** ACK flush 超时（ms） */
  private readonly ACK_FLUSH_TIMEOUT = 5

  /**
   * 可选：WorkerPool 多进程架构。
   * 当配置了 workerPoolConcurrency > 1 时，EventBus 不再创建和管理 DEALER sockets，
   * 改为通过 WorkerPool 发送。ROUTER socket 仍保留在主进程。
   */
  workerPool?: EventBusWorkerPool

  constructor(config: EventBusConfig) {
    this.config = {
      ...config,
      publishAddress: config.publishAddress ?? null,
      subscribeAddresses: config.subscribeAddresses ?? [],
      isRaftLeader: config.isRaftLeader ?? false,
    }
    this.logger = new Logger('EventBus')
  }

  // ── CURVE 密钥生成与磁盘管理 ─────────

  static generateCurveKeys(): { publicKey: string; secretKey: string } {
    return zmq.curveKeyPair()
  }

  static writePublicKeyToDir(dir: string, nodeId: string, port: number, publicKey: string): void {
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, publicKeyFileForEndpoint(nodeId, port))
    fs.writeFileSync(filePath, publicKey, 'utf-8')
  }

  static readAllPeerKeys(dir: string): PeerDescriptor[] {
    const result: PeerDescriptor[] = []
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      return result
    }
    for (const entry of entries) {
      if (!entry.endsWith('.pub')) continue
      const parsed = parsePubFilename(entry)
      if (!parsed) continue
      const filePath = path.join(dir, entry)
      try {
        const key = fs.readFileSync(filePath, 'utf-8').trim()
        if (key) {
          result.push({
            nodeId: parsed.nodeId,
            port: parsed.port,
            address: `tcp://127.0.0.1:${parsed.port}`,
            publicKey: key,
          })
        }
      } catch { /* skip unreadable */ }
    }
    return result
  }

  /**
   * 解析 CURVE 配置：
   * 1. 生成本机密钥对（secretKey + publicKey）
   * 2. 将公钥写入共享目录
   * 3. 扫描目录发现所有 peer 公钥
   * 4. 返回 resolved 配置（含密钥 + peer 信息）
   */
  static async resolveCurveConfig(security: EventBusSecurity): Promise<{
    secretKey: string
    publicKey: string
    peerKeys: Record<string, string>
    peerAddresses: string[]
    peerNodeIds: string[]
  }> {
    const curve = security.curve
    const { publicKey, secretKey } = EventBus.generateCurveKeys()
    EventBus.writePublicKeyToDir(curve.publicKeyDir, curve.nodeId, curve.port, publicKey)
    const allPeers = await EventBus.waitForPeerKeys(curve.publicKeyDir, curve.nodeId)

    const peerKeys: Record<string, string> = {}
    const peerAddresses: string[] = []
    const peerNodeIds: string[] = []

    for (const peer of allPeers) {
      if (peer.nodeId === curve.nodeId) continue
      peerKeys[peer.nodeId] = peer.publicKey
      peerKeys[peer.address] = peer.publicKey
      peerAddresses.push(peer.address)
      peerNodeIds.push(peer.nodeId)
    }

    return { secretKey, publicKey, peerKeys, peerAddresses, peerNodeIds }
  }

  static async waitForPeerKeys(dir: string, selfNodeId?: string, minPeers = 1): Promise<PeerDescriptor[]> {
    const deadline = Date.now() + 10000
    let lastPeers: PeerDescriptor[] = []
    while (Date.now() < deadline) {
      try { lastPeers = EventBus.readAllPeerKeys(dir) } catch { /* ignore */ }
      const peerCount = selfNodeId
        ? lastPeers.filter(p => p.nodeId !== selfNodeId).length
        : lastPeers.length
      if (peerCount >= minPeers) return lastPeers
      await new Promise(r => setTimeout(r, 200))
    }
    return lastPeers
  }

  // ── 生命周期 ─────────────────────────

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    if (!this.config.security?.curve) {
      throw new Error(
        'EventBus: CURVE security is required when using ZMQ. ' +
        'Provide a `security.curve` config with nodeId, port, server, and publicKeyDir.',
      )
    }

    const curve = this.config.security.curve
    const curveDir = process.env.EVENTBUS_CURVE_DIR || curve.publicKeyDir
    this.nasKeyDir = curveDir
    ;(this.config.security.curve as any).publicKeyDir = curveDir

    if (!this.config.publishAddress && curve.port) {
      this.config.publishAddress = `tcp://0.0.0.0:${curve.port}`
    }

    // 解析 CURVE 配置：生成密钥对 + 公钥分发 + 扫描 peer
    const { secretKey, publicKey, peerKeys, peerAddresses, peerNodeIds } =
      await EventBus.resolveCurveConfig(this.config.security)

    // 存储解析后的密钥供 _applyCurveToSocket 使用
    ;(this.config as any)._resolvedCurve = { secretKey, publicKey, peerKeys }
    ;(this.config as any)._peerNodeIds = peerNodeIds

    // 自动填充 subscribeAddresses（如果未手动指定）
    if (!this.config.subscribeAddresses || this.config.subscribeAddresses.length === 0) {
      this.config.subscribeAddresses = peerAddresses
    }

    // 1. 启动 ROUTER（Server）
    if (!this.config.isRaftLeader && this.config.publishAddress) {
      this.routerSocket = new zmq.Router()
      this._applyCurveToSocket(this.routerSocket, true)
      await this.routerSocket.bind(this.config.publishAddress)
      this.logger.info(`ROUTER bound to ${this.config.publishAddress}`)
      this._startRouterLoop()
    }

    // 2. 为每个 peer 创建 DEALER（Client）
    if (this.config.subscribeAddresses.length > 0) {
      const pnids = (this.config as any)._peerNodeIds as string[] | undefined

      for (let i = 0; i < this.config.subscribeAddresses.length; i++) {
        const addr = this.config.subscribeAddresses[i]
        const peerNodeId = pnids?.[i] || `peer-${i}`

        const dealer = new zmq.Dealer()
        this._applyCurveToSocket(dealer, false)

        // DEALER(client) 需要对方 ROUTER(server) 的公钥
        const s = dealer as any
        s.curvePublicKey = publicKey
        s.curveSecretKey = secretKey
        const serverKey = peerKeys[peerNodeId] || peerKeys[addr] || Object.values(peerKeys).find(k => k !== publicKey)
        if (serverKey) s.curveServerKey = serverKey

        await dealer.connect(addr)
        this.dealerSockets.set(peerNodeId, dealer)
        this.logger.info(`DEALER connected to ${addr} (peer: ${peerNodeId})`)
      }
    }

    // 启动 NAS 目录动态监控（默认 3 秒，可配置）
    const nasInterval = this.config.nasMonitorIntervalMs ?? 3000
    if (nasInterval > 0) {
      this._startNasMonitor(nasInterval)
    }
  }

  /**
   * 停止 EventBus，关闭所有 ZMQ socket
   */
  async stop(): Promise<void> {
    this.running = false
    // 清除 NAS 监控定时器
    if (this._nasMonitorTimer) {
      clearInterval(this._nasMonitorTimer)
      this._nasMonitorTimer = null
    }
    // 停止 WorkerPool（如果已激活）
    if (this.workerPool) {
      await this.workerPool.stop().catch(() => {})
      this.workerPool = undefined
    }
    if (this.routerSocket) {
      this.routerSocket.close()
      this.routerSocket = null
    }
    for (const dealer of this.dealerSockets.values()) {
      dealer.close()
    }
    this.dealerSockets.clear()
    this.identityToNode.clear()
    this.nodeToIdentity.clear()
    this.local.removeAllListeners()
    this.receiveHandler = null
  }

  // ── 消息发送 ─────────────────────────

  /**
   * 发送消息给指定 peer
   *
   * 如果 WorkerPool 已激活（workerPoolConcurrency > 0），
   * 则路由到对应的子进程发送；否则通过主进程的 DEALER socket 直接发送。
   */
  async send(nodeId: string, msg: TransportMessage): Promise<void> {
    // WorkerPool 模式：路由到子进程
    if (this.workerPool) {
      await this.workerPool.send(nodeId, [msg])
      return
    }

    // 传统模式：主进程 DEALER socket 直接发送
    const dealer = this.dealerSockets.get(nodeId)
    if (!dealer) {
      this.logger.warn(`no DEALER for peer ${nodeId}, trying broadcast`)
      this.broadcast(msg)
      return
    }
    const payload = Buffer.from(JSON.stringify(msg))
    try {
      await dealer.send([payload])
    } catch (err: any) {
      this.logger.warn(`DEALER send to ${nodeId} error: ${err.message}`)
    }
  }

  /**
   * 广播消息给所有 peer
   *
   * 如果 WorkerPool 已激活，通过所有子进程逐条发送；否则遍历主进程 DEALER 发送。
   */
  broadcast(msg: TransportMessage): void {
    // WorkerPool 模式：逐个 peer 路由到子进程
    if (this.workerPool) {
      const allNodeIds = this.getPeerNodeIds()
      for (const nodeId of allNodeIds) {
        this.workerPool.send(nodeId, [msg]).catch((err: Error) => {
          this.logger.warn(`WorkerPool broadcast to ${nodeId} error: ${err.message}`)
        })
      }
      return
    }

    // 传统模式：主进程 DEALER 直接发送
    for (const [nodeId, dealer] of this.dealerSockets) {
      const payload = Buffer.from(JSON.stringify(msg))
      dealer.send([payload]).catch((err: Error) => {
        this.logger.warn(`DEALER broadcast to ${nodeId} error: ${err.message}`)
      })
    }
  }

  /**
   * 批量发送消息给指定 peer，通过 ZMQ multi-part 帧序列提升吞吐量。
   *
   * 如果 WorkerPool 已激活，路由到子进程（子进程内部处理 ZMQ multi-part）。
   * 否则通过主进程 DEALER socket 发送。
   *
   * 前 N-1 帧带 ZMQ_SENDMORE 标记，最后一帧不带。
   * 如果 zmq 版本不支持 ZMQ_SENDMORE 或 dealer 不存在，退化为并发逐条发送。
   */
  async batchSend(nodeId: string, msgs: TransportMessage[]): Promise<void> {
    // WorkerPool 模式：路由到子进程（子进程处理 multi-part 批发送）
    if (this.workerPool) {
      await this.workerPool.send(nodeId, msgs)
      return
    }

    // 传统模式：主进程 DEALER socket 直接发送
    const dealer = this.dealerSockets.get(nodeId)
    if (!dealer) {
      // 退化为逐条广播
      for (const msg of msgs) this.broadcast(msg)
      return
    }

    // 检查 ZMQ_SENDMORE 支持
    const hasSendMore = typeof zmq.ZMQ_SENDMORE === 'number'

    if (hasSendMore && msgs.length > 1) {
      // ZMQ multi-part: 发送 N 帧，前 N-1 帧带 SNDMORE，最后一帧不带
      for (let i = 0; i < msgs.length; i++) {
        const payload = Buffer.from(JSON.stringify(msgs[i]))
        if (i < msgs.length - 1) {
          await dealer.send([payload], zmq.ZMQ_SENDMORE)
        } else {
          await dealer.send([payload])
        }
      }
    } else {
      // 退化：并发发送所有消息
      await Promise.all(msgs.map(msg => this.send(nodeId, msg).catch(() => {})))
    }
  }

  /**
   * 获取已连接的 peer nodeId 列表
   */
  getPeerNodeIds(): string[] {
    return Array.from(this.dealerSockets.keys())
  }

  // ── 本地监听 ─────────────────────────

  /**
   * 注册消息接收回调（由 EventStream 调用）
   */
  setReceiveHandler(handler: (msg: TransportMessage, fromNodeId: string) => void): void {
    this.receiveHandler = handler
  }

  // ── 局部事件（本进程内）─────────────

  emit(event: Omit<GraphEvent, 'nodeId'>): void {
    const fullEvent: GraphEvent = { ...event, nodeId: this.config.nodeId }
    this.local.emit(event.type, fullEvent)
  }

  on(type: GraphEventType, handler: (event: GraphEvent) => void): void {
    this.local.on(type, handler)
  }

  off(type: GraphEventType, handler: (event: GraphEvent) => void): void {
    this.local.off(type, handler)
  }

  clear(): void {
    this.local.removeAllListeners()
  }

  // ── 内部 ─────────────────────────────

  /**
   * 将 CURVE 安全配置应用到 ZMQ socket
   *
   * CURVE 是强制安全机制，此处无条件应用。
   * 密钥信息已在 start() 中解析并存储在 `_resolvedCurve`。
   * 注意：DEALER(client) 端的 curveServerKey 在 start() DEALER 创建循环中单独设置，
   * 因为不同 peer 的 serverKey 不同，不能在这里统一设置。
   *
   * @param isRouter - true = ROUTER(server)，false = DEALER(client)
   */
  private _applyCurveToSocket(socket: Router | Dealer, isRouter: boolean): void {
    const resolved = (this.config as any)._resolvedCurve as { secretKey: string; publicKey: string; peerKeys: Record<string, string> } | undefined
    if (!resolved) {
      throw new Error('EventBus: CURVE keys not resolved. Call start() to initialize.')
    }

    const s = socket as any
    s.curveServer = isRouter  // ROUTER=server, DEALER=client
    s.curveSecretKey = resolved.secretKey
    s.curvePublicKey = resolved.publicKey
  }

  // ── NAS 目录动态监控 ────────────────

  /**
   * 启动 NAS 目录动态监控。
   * 周期性扫描 curveDir，动态创建/关闭 DEALER socket。
   *
   * @param intervalMs 扫描间隔（毫秒），默认 3000
   */
  private _startNasMonitor(intervalMs = 3000): void {
    if (this._nasMonitorTimer) {
      clearInterval(this._nasMonitorTimer)
    }
    this._nasMonitorTimer = setInterval(() => {
      try {
        this._syncPeerDealers()
      } catch (err: any) {
        this.logger.warn(`NAS monitor sync error: ${err.message}`)
      }
    }, intervalMs)
    this._nasMonitorTimer.unref()
    this.logger.info(`NAS monitor started (interval=${intervalMs}ms)`)
  }

  /**
   * 扫描 NAS 目录，对比当前 DEALER，创建新增 peer 的 DEALER、关闭消失 peer 的 DEALER。
   */
  private _syncPeerDealers(): void {
    if (!this.nasKeyDir) return

    const resolved = (this.config as any)._resolvedCurve as { secretKey: string; publicKey: string; peerKeys: Record<string, string> } | undefined
    if (!resolved) return

    const allPeers = EventBus.readAllPeerKeys(this.nasKeyDir)
    const selfNodeId = this.config.nodeId

    // 构建当前 peer 集合（排除自身）
    const currentPeers = new Set<string>()
    for (const peer of allPeers) {
      if (peer.nodeId !== selfNodeId) {
        currentPeers.add(peer.nodeId)
      }
    }

    const existingPeerIds = new Set(this.dealerSockets.keys())

    // ── 新增 peer（currentPeers - existingPeerIds）──
    for (const peerNodeId of currentPeers) {
      if (!existingPeerIds.has(peerNodeId)) {
        const peer = allPeers.find(p => p.nodeId === peerNodeId)
        if (!peer) continue

        try {
          const dealer = new zmq.Dealer()
          this._applyCurveToSocket(dealer, false)

          const s = dealer as any
          s.curvePublicKey = resolved.publicKey
          s.curveSecretKey = resolved.secretKey

          // 设置对方 ROUTER 的公钥
          const serverKey = resolved.peerKeys[peerNodeId] || resolved.peerKeys[peer.address] || peer.publicKey
          if (serverKey) {
            s.curveServerKey = serverKey
          } else {
            this.logger.warn(`_syncPeerDealers: no curveServerKey for peer ${peerNodeId}, using ${peer.publicKey}`)
            s.curveServerKey = peer.publicKey
          }

          dealer.connect(peer.address)
          this.dealerSockets.set(peerNodeId, dealer)
          this.logger.info(`[NAS] DEALER created for new peer ${peerNodeId} @ ${peer.address}`)
        } catch (err: any) {
          this.logger.warn(`[NAS] failed to create DEALER for ${peerNodeId}: ${err.message}`)
        }
      }
    }

    // ── 消失 peer（existingPeerIds - currentPeers）──
    for (const peerNodeId of existingPeerIds) {
      if (!currentPeers.has(peerNodeId)) {
        const dealer = this.dealerSockets.get(peerNodeId)
        if (dealer) {
          try {
            dealer.close()
          } catch { /* ignore close error */ }
          this.dealerSockets.delete(peerNodeId)
          this.logger.info(`[NAS] DEALER closed for gone peer ${peerNodeId}`)
        }

        // 从 identity 映射清理
        const identity = this.nodeToIdentity.get(peerNodeId)
        if (identity) {
          this.identityToNode.delete(identity)
          this.nodeToIdentity.delete(peerNodeId)
        }
      }
    }

    // 更新 _peerNodeIds 列表
    (this.config as any)._peerNodeIds = Array.from(currentPeers)
  }

  /**
   * 按 nodeId 重建 DEALER socket。
   * 如果该 nodeId 已有 DEALER，先 close 旧的再重建。
   * 用于 Outbox PerPeerWorker 退避恢复时重建连接。
   *
   * @returns true=成功重建，false=未找到对应 peer 公钥
   */
  async _recoverDealerByNodeId(nodeId: string): Promise<boolean> {
    if (!this.nasKeyDir) return false

    // 关闭已有的 DEALER（如果有）
    const oldDealer = this.dealerSockets.get(nodeId)
    if (oldDealer) {
      try {
        oldDealer.close()
      } catch { /* ignore */ }
      this.dealerSockets.delete(nodeId)
    }

    // 扫描目录找到该 nodeId 的 peer
    const allPeers = EventBus.readAllPeerKeys(this.nasKeyDir)
    const peer = allPeers.find(p => p.nodeId === nodeId)
    if (!peer) {
      this.logger.warn(`_recoverDealerByNodeId: no peer found for ${nodeId}`)
      return false
    }

    const resolved = (this.config as any)._resolvedCurve as { secretKey: string; publicKey: string; peerKeys: Record<string, string> } | undefined
    if (!resolved) {
      this.logger.warn(`_recoverDealerByNodeId: no resolved curve keys`)
      return false
    }

    try {
      const dealer = new zmq.Dealer()
      this._applyCurveToSocket(dealer, false)

      const s = dealer as any
      s.curvePublicKey = resolved.publicKey
      s.curveSecretKey = resolved.secretKey

      const serverKey = resolved.peerKeys[nodeId] || resolved.peerKeys[peer.address] || peer.publicKey
      if (serverKey) {
        s.curveServerKey = serverKey
      } else {
        s.curveServerKey = peer.publicKey
      }

      await dealer.connect(peer.address)
      this.dealerSockets.set(nodeId, dealer)
      this.logger.info(`[NAS] DEALER recovered for peer ${nodeId} @ ${peer.address}`)
      return true
    } catch (err: any) {
      this.logger.warn(`[NAS] failed to recover DEALER for ${nodeId}: ${err.message}`)
      return false
    }
  }

  /**
   * 批量 flush ACK 消息
   *
   * 将 _ackBatchQueue 中的 ACK 逐条调用 receiveHandler，然后清空队列。
   */
  private _ackBatchFlush(): void {
    if (this._ackFlushTimer) {
      clearTimeout(this._ackFlushTimer)
      this._ackFlushTimer = null
    }
    if (this._ackBatchQueue.length === 0 || !this.receiveHandler) return

    const batch = this._ackBatchQueue.splice(0)
    for (const { ackMsgId, srcNodeId } of batch) {
      this.receiveHandler(
        {
          msgId: `batch-ack-${ackMsgId}`,
          type: 'ack',
          srcNodeId,
          ackMsgId,
          data: {},
        },
        srcNodeId,
      )
    }
  }

  /**
   * 启动 ROUTER 接收循环（生产者/消费者模式）
   *
   * - 生产者：仅做 ZMQ receive() → JSON.parse → 入队 buffer
   * - 消费者：从 buffer 批量取帧，按 type 分组分发
   *
   * ZMQ ROUTER 的消息格式：[identity, ...frames]
   * identity 是 ROUTER 自动为每个 DEALER 连接分配的 routing ID。
   */
  private _startRouterLoop(): void {
    // ── 生产者：快速收帧入队 ──
    const producer = async () => {
      while (this.running && this.routerSocket) {
        try {
          const frames = await (this.routerSocket as any).receive()
          if (!this.running || !frames || frames.length < 2) break

          const identity = frames[0]
          const payload = frames[frames.length - 1]
          const text = Buffer.from(payload).toString('utf-8')

          let msg: TransportMessage
          try { msg = JSON.parse(text) } catch { continue }

          const idStr = identity.toString('hex')

          // 更新 identity→nodeId 映射
          if (msg.srcNodeId) {
            this.identityToNode.set(idStr, msg.srcNodeId)
            this.nodeToIdentity.set(msg.srcNodeId, idStr)
          }

          const fromNodeId = msg.srcNodeId || idStr

          // 入队（快速释放，不阻塞 receive）
          this._routerBuffer.push({ msg, fromNodeId })
        } catch (err: any) {
          if (!this.running) break
          this.logger.warn(`ROUTER receive error: ${err.message}`)
        }
      }
    }

    // ── 消费者：批量出队 dispatch ──
    const consumer = async () => {
      while (this.running) {
        // 使用 setImmediate 让出事件循环，不阻塞 ZMQ receive
        await new Promise<void>(resolve => setImmediate(resolve))

        if (this._routerBuffer.length === 0) continue

        // 批量取出当前所有缓冲帧
        const batch = this._routerBuffer.splice(0)

        for (const { msg, fromNodeId } of batch) {
          if (msg.type === 'ack') {
            // ACK 消息批量积压
            if (msg.ackMsgId) {
              this._ackBatchQueue.push({ ackMsgId: msg.ackMsgId, srcNodeId: fromNodeId })

              // 达到批量阈值 → 立即 flush
              if (this._ackBatchQueue.length >= this.ACK_BATCH_SIZE) {
                this._ackBatchFlush()
              } else if (!this._ackFlushTimer) {
                // 设置超时 flush（首次积压时启动定时器）
                this._ackFlushTimer = setTimeout(() => {
                  this._ackBatchFlush()
                }, this.ACK_FLUSH_TIMEOUT)
                this._ackFlushTimer.unref()
              }
            }
          } else {
            // 非 ACK 消息（data、sync-query 等）：直接 dispatch
            if (this.receiveHandler) {
              this.receiveHandler(msg, fromNodeId)
            }
          }
        }
      }
    }

    producer()
    consumer()
  }
}

// ── 全局单例 ──────────────────────────

let _instance: EventBus | null = null
const _initLogger = new Logger('EventBus')

export async function initEventBus(config: EventBusConfig): Promise<EventBus> {
  if (_instance) {
    await _instance.stop().catch(() => {})
  }
  _instance = new EventBus(config)
  await _instance.start().catch((err) => {
    _initLogger.error(`init error: ${err.message}`)
  })
  return _instance
}

export function getEventBus(): EventBus {
  if (!_instance) {
    throw new Error('EventBus not initialized. Call initEventBus(config) first.')
  }
  return _instance
}
