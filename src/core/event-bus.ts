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
type Router = any
type Dealer = any
import * as fs from 'node:fs'
import * as path from 'node:path'

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
export type CurveKeyMode = 'explicit' | 'nas'

/**
 * CURVE 安全配置（explicit 模式）
 */
export interface CurveExplicitConfig {
  mode: 'explicit'
  server: boolean
  secretKey: string
  publicKey: string
  peerKeys?: Record<string, string>
}

/**
 * CURVE 安全配置（NAS 共享目录模式）
 *
 * 文件名格式：`{nodeId}_{port}.pub`，内容 = 一行 CURVE 公钥。
 * 每个进程启动时写入自己的文件，扫描目录中所有 `*.pub` 文件自动发现 peer。
 *
 * NAS 目录路径优先使用 `EVENTBUS_CURVE_DIR` 环境变量，未设置时回退到 `publicKeyDir`。
 */
export interface CurveNasConfig {
  mode: 'nas'
  /** 本节点 ID（唯一标识） */
  nodeId: string
  /** 本节点 ROUTER 监听端口 */
  port: number
  /** 是否作为 CURVE server（ROUTER 端），ROUTER/SERVER=true，DEALER/SERVER=false */
  server: boolean
  /** NAS 共享公钥目录路径（回退值，`EVENTBUS_CURVE_DIR` 环境变量优先） */
  publicKeyDir: string
}

/**
 * CURVE 安全配置
 */
export type CurveConfig = CurveExplicitConfig | CurveNasConfig

/**
 * 传输安全配置
 */
export interface EventBusSecurity {
  curve: CurveConfig
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
function parsePubFilename(filename: string): { nodeId: string; port: number } | null {
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
  private nasKeyFiles: Set<string> | null = null

  /**
   * 消息接收回调：EventStream 注册此回调处理收到的所有消息。
   * 参数：(msg: TransportMessage, fromNodeId: string)
   */
  private receiveHandler: ((msg: TransportMessage, fromNodeId: string) => void) | null = null

  constructor(config: EventBusConfig) {
    this.config = {
      ...config,
      publishAddress: config.publishAddress ?? null,
      subscribeAddresses: config.subscribeAddresses ?? [],
      isRaftLeader: config.isRaftLeader ?? false,
    }
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

  static async resolveCurveConfig(security: EventBusSecurity): Promise<{
    explicitConfig: CurveExplicitConfig
    peerAddresses: string[]
    peerNodeIds: string[]
  }> {
    const curve = security.curve as CurveNasConfig
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

    return {
      explicitConfig: { mode: 'explicit', server: curve.server, secretKey, publicKey, peerKeys },
      peerAddresses,
      peerNodeIds,
    }
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

    // NAS 模式：自动生成密钥对 + 公钥分发 + 推导地址
    if (this.config.security?.curve?.mode === 'nas') {
      const nasConfig = this.config.security.curve as CurveNasConfig
      const curveDir = process.env.EVENTBUS_CURVE_DIR || nasConfig.publicKeyDir
      nasConfig.publicKeyDir = curveDir
      this.nasKeyDir = curveDir

      if (!this.config.publishAddress) {
        this.config.publishAddress = `tcp://0.0.0.0:${nasConfig.port}`
      }

      const { explicitConfig, peerAddresses, peerNodeIds } = await EventBus.resolveCurveConfig(this.config.security)

      this.config = {
        ...this.config,
        security: { curve: explicitConfig },
        subscribeAddresses: this.config.subscribeAddresses && this.config.subscribeAddresses.length > 0
          ? this.config.subscribeAddresses
          : peerAddresses,
      }

      // 保存 peerNodeIds 供 DEALER 创建使用
      ;(this.config as any)._peerNodeIds = peerNodeIds
    }

    // CURVE 是强制安全机制
    const hasZMQ = (!this.config.isRaftLeader && this.config.publishAddress) ||
      (this.config.subscribeAddresses!.length > 0)
    if (hasZMQ && !this.config.security?.curve) {
      throw new Error(
        'EventBus: CURVE security is required when using ZMQ. ' +
        'Provide a `security.curve` config.',
      )
    }

    // 1. 启动 ROUTER（Server）
    if (!this.config.isRaftLeader && this.config.publishAddress) {
      this.routerSocket = new zmq.Router()
      this._applyCurveToSocket(this.routerSocket, true)
      await this.routerSocket.bind(this.config.publishAddress)
      console.log(`EventBus ROUTER bound to ${this.config.publishAddress}`)
      this._startRouterLoop()
    }

    // 2. 为每个 peer 创建 DEALER（Client）
    if (this.config.subscribeAddresses!.length > 0) {
      const peerNodeIds = (this.config as any)._peerNodeIds as string[] | undefined
      const curve = this.config.security?.curve

      for (let i = 0; i < this.config.subscribeAddresses!.length; i++) {
        const addr = this.config.subscribeAddresses![i]
        const peerNodeId = peerNodeIds?.[i] || `peer-${i}`

        const dealer = new zmq.Dealer()
        this._applyCurveToSocket(dealer, false)

        // CURVE：DEALER 作为 client，需要对方 ROUTER 的公钥
        if (curve?.mode === 'explicit' && curve.peerKeys) {
          const s = dealer as any
          s.curvePublicKey = curve.publicKey
          s.curveSecretKey = curve.secretKey
          // 通过 nodeId 查对方公钥
          const serverKey = curve.peerKeys[peerNodeId] || curve.peerKeys[addr] || Object.values(curve.peerKeys).find(k => k !== curve.publicKey)
          if (serverKey) s.curveServerKey = serverKey
        }

        await dealer.connect(addr)
        this.dealerSockets.set(peerNodeId, dealer)
        console.log(`EventBus DEALER connected to ${addr} (peer: ${peerNodeId})`)
      }
    }
  }

  /**
   * 停止 EventBus，关闭所有 ZMQ socket
   */
  async stop(): Promise<void> {
    this.running = false
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
   */
  send(nodeId: string, msg: TransportMessage): void {
    const dealer = this.dealerSockets.get(nodeId)
    if (!dealer) {
      console.warn(`EventBus: no DEALER for peer ${nodeId}, trying broadcast`)
      this.broadcast(msg)
      return
    }
    const payload = Buffer.from(JSON.stringify(msg))
    dealer.send([payload]).catch((err: Error) => {
      console.warn(`EventBus DEALER send to ${nodeId} error: ${err.message}`)
    })
  }

  /**
   * 广播消息给所有 peer
   */
  broadcast(msg: TransportMessage): void {
    for (const [nodeId, dealer] of this.dealerSockets) {
      const payload = Buffer.from(JSON.stringify(msg))
      dealer.send([payload]).catch((err: Error) => {
        console.warn(`EventBus DEALER broadcast to ${nodeId} error: ${err.message}`)
      })
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
   * @param isRouter - true = ROUTER(server)，false = DEALER(client)
   */
  private _applyCurveToSocket(socket: Router | Dealer, isRouter: boolean): void {
    const curve = this.config.security?.curve
    if (!curve || curve.mode !== 'explicit') return

    const s = socket as any
    s.curveServer = isRouter  // ROUTER=server, DEALER=client
    s.curveSecretKey = curve.secretKey
    s.curvePublicKey = curve.publicKey

    // DEALER(client) 需要对方 ROUTER(server) 的公钥
    if (!isRouter && curve.peerKeys) {
      // 取第一个非本机公钥作为默认 serverKey
      // 每个 DEALER connect 前具体设置（在 start() 中已完成）
    }
  }

  /**
   * 启动 ROUTER 接收循环
   *
   * ZMQ ROUTER 的消息格式：[identity, ...frames]
   * identity 是 ROUTER 自动为每个 DEALER 连接分配的 routing ID。
   * 收到消息后解析 JSON payload，通过 identity→nodeId 映射追踪来源。
   */
  private _startRouterLoop(): void {
    const poll = async () => {
      while (this.running && this.routerSocket) {
        try {
          const frames = await (this.routerSocket as any).receive()
          if (!this.running || !frames || frames.length < 2) break

          // ROUTER 消息格式: [identity, dataFrame]
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

          // 分发到 EventStream 的 receive handler
          if (this.receiveHandler) {
            this.receiveHandler(msg, fromNodeId)
          }
        } catch (err: any) {
          if (!this.running) break
          console.warn(`EventBus ROUTER receive error: ${err.message}`)
        }
      }
    }
    poll()
  }
}

// ── 全局单例 ──────────────────────────

let _instance: EventBus | null = null

export async function initEventBus(config: EventBusConfig): Promise<EventBus> {
  if (_instance) {
    await _instance.stop().catch(() => {})
  }
  _instance = new EventBus(config)
  await _instance.start().catch((err) => {
    console.error(`EventBus init error: ${err.message}`)
  })
  return _instance
}

export function getEventBus(): EventBus {
  if (!_instance) {
    throw new Error('EventBus not initialized. Call initEventBus(config) first.')
  }
  return _instance
}
