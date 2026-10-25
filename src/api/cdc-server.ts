/**
 * cdc-server.ts — CDC 外围接口服务
 *
 * 提供三种订阅方式:
 *   1. WebSocket 端点: ws://host:port/cdc
 *   2. HTTP Long-Polling: GET /api/v1/cdc/stream?since=<seq>&labels=xxx
 *   3. Webhook Push: 配置 URL 后 POST 变更事件
 *
 * 架构：
 *   CdcServer 持有 CdcAdapter 的引用，注册为事件订阅者，
 *   然后将事件分发到 WebSocket 客户端、HTTP Long-Polling 响应、Webhook 推送。
 *
 * WebSocket 协议：
 *   客户端连接后，实时接收所有匹配的 CDC 事件（JSON 编码）。
 *   客户端可发送 JSON 消息设置过滤条件：
 *     { "type": "subscribe", "filter": { "labels": ["Person"], "ops": ["create"] } }
 *
 * HTTP Long-Polling:
 *   GET /api/v1/cdc/stream?since=<seq>&labels=Person,Company&ops=create,update
 *   返回 JSON 数组 [CdcEvent, ...]
 *   如果没有新事件，hold 30 秒后返回空数组。
 *
 * Webhook:
 *   配置 webhookUrls 数组，每次 CDC 事件触发后 POST 到所有 webhook URL。
 */

import { IncomingMessage, ServerResponse } from 'http'
import * as http from 'http'
import { CdcAdapter, CdcEvent, CdcFilter } from '../core/cdc-adapter'
import { Logger } from '../ops/logger'
import { URL } from 'url'

/** WebSocket 消息类型 */
interface WsSubscribeMessage {
  type: 'subscribe'
  filter?: CdcFilter
}

/** WebSocket 客户端状态 */
interface WsClient {
  id: string
  send: (data: string) => void
  close: () => void
  filter?: CdcFilter
  connectedAt: number
}

/** CDC 服务配置 */
export interface CdcServerConfig {
  /** CDC 适配器引用 */
  adapter: CdcAdapter
  /** 挂载路径 */
  wsPath?: string
  httpPath?: string
  /** Webhook 推送 URL 列表 */
  webhookUrls?: string[]
  /**
   * Webhook POST 请求的自定义 headers。
   * 例如用于认证：{ "Authorization": "Bearer xxx" }
   */
  webhookHeaders?: Record<string, string>
  /** Long-Polling 最长等待时间（ms），默认 30000 */
  longPollTimeoutMs?: number
  /** 缓冲区最大事件数，默认 10000 */
  maxBufferSize?: number
}

/**
 * 简化版 WebSocket 帧编码（仅支持文本帧）
 */
function encodeWsFrame(payload: string): Buffer {
  const data = Buffer.from(payload, 'utf-8')
  const len = data.length
  const buf = Buffer.alloc(len + 10) // 最大额外开销
  let offset = 0
  buf[offset++] = 0x81 // FIN + text opcode
  if (len < 126) {
    buf[offset++] = len
  } else if (len < 65536) {
    buf[offset++] = 126
    buf.writeUInt16BE(len, offset)
    offset += 2
  } else {
    buf[offset++] = 127
    buf.writeBigUInt64BE(BigInt(len), offset)
    offset += 8
  }
  data.copy(buf, offset)
  return buf.subarray(0, offset + len)
}

/**
 * 解析 WebSocket 帧（仅支持文本帧，无掩码）
 */
function parseWsFrame(buf: Buffer): { opcode: number; payload: Buffer; fin: boolean } | null {
  if (buf.length < 2) return null
  const fin = (buf[0] & 0x80) !== 0
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let payloadLen = buf[1] & 0x7f
  let offset = 2
  if (payloadLen === 126) {
    if (buf.length < 4) return null
    payloadLen = buf.readUInt16BE(offset)
    offset += 2
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null
    payloadLen = Number(buf.readBigUInt64BE(offset))
    offset += 8
  }
  let mask: Buffer | undefined
  if (masked) {
    if (buf.length < offset + 4) return null
    mask = buf.subarray(offset, offset + 4)
    offset += 4
  }
  if (buf.length < offset + payloadLen) return null
  let payload = buf.subarray(offset, offset + payloadLen)
  if (mask) {
    payload = Buffer.from(payload)
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i % 4]
    }
  }
  return { opcode, payload, fin }
}

/**
 * CdcServer — CDC 外围接口服务
 *
 * 提供 WebSocket / HTTP Long-Polling / Webhook 的 CDC 事件订阅。
 * 使用 Node.js 原生 http 模块，不需要额外的 WebSocket 库依赖。
 */
export class CdcServer {
  private config: CdcServerConfig
  private adapter: CdcAdapter
  private logger: Logger
  /** WebSocket 客户端列表 */
  private wsClients: Map<string, WsClient> = new Map()
  /** Long-Polling 挂起的响应 */
  private pendingPolls: Array<{
    res: ServerResponse
    filter?: CdcFilter
    sinceSeq: number
    timer: ReturnType<typeof setTimeout>
  }> = []
  /** WebSocket 升级处理函数回调 */
  private wsUpgradeCallback: ((req: IncomingMessage, socket: any, head: Buffer) => void) | null = null

  private clientIdCounter = 0
  private longPollTimerId = 0

  constructor(config: CdcServerConfig) {
    this.config = {
      wsPath: '/cdc',
      httpPath: '/api/v1/cdc/stream',
      longPollTimeoutMs: 30000,
      ...config,
    }
    this.adapter = config.adapter
    this.logger = new Logger('CdcServer')

    // 注册为 CDC 事件订阅者
    this.adapter.subscribe('__cdc-server__', (event) => {
      this._onCdcEvent(event)
    })
  }

  /**
   * 获取 WebSocket 升级处理函数。
   * 在 HTTP 服务器上调用 `server.on('upgrade', cdcServer.handleUpgrade)` 来挂载。
   */
  get handleUpgrade(): (req: IncomingMessage, socket: any, head: Buffer) => void {
    return (req: IncomingMessage, socket: any, head: Buffer) => {
      this._onUpgrade(req, socket, head)
    }
  }

  /**
   * 处理 HTTP 请求。
   * 在 HTTP 路由中调用。
   *
   * @param req - HTTP 请求
   * @param res - HTTP 响应
   * @returns true 如果请求被 CDC 服务处理，false 否则
   */
  handleRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    // HTTP Long-Polling
    if (url.pathname === this.config.httpPath && req.method === 'GET') {
      this._handleLongPolling(req, res, url)
      return true
    }

    return false
  }

  /**
   * 注册一个 Webhook URL。
   * 添加后，新的 CDC 事件会自动 POST 到此 URL。
   */
  addWebhook(url: string): void {
    if (!this.config.webhookUrls) {
      this.config.webhookUrls = []
    }
    if (!this.config.webhookUrls.includes(url)) {
      this.config.webhookUrls.push(url)
    }
  }

  /**
   * 移除一个 Webhook URL。
   */
  removeWebhook(url: string): void {
    if (this.config.webhookUrls) {
      this.config.webhookUrls = this.config.webhookUrls.filter(u => u !== url)
    }
  }

  /**
   * 统计Info
   */
  stats(): { wsConnections: number; pendingPolls: number; webhookCount: number; bufferLength: number } {
    return {
      wsConnections: this.wsClients.size,
      pendingPolls: this.pendingPolls.length,
      webhookCount: this.config.webhookUrls?.length ?? 0,
      bufferLength: this.adapter.bufferLength,
    }
  }

  /**
   * 清理资源。
   */
  close(): void {
    // 关闭所有 WebSocket 连接
    for (const [, client] of this.wsClients) {
      try { client.close() } catch { /* ignore */ }
    }
    this.wsClients.clear()

    // 完成所有挂起的 Long-Polling 请求
    for (const poll of this.pendingPolls) {
      clearTimeout(poll.timer)
      try {
        poll.res.writeHead(200, { 'Content-Type': 'application/json' })
        poll.res.end('[]')
      } catch { /* ignore */ }
    }
    this.pendingPolls = []

    this.adapter.unsubscribe('__cdc-server__')
  }

  // ── WebSocket 处理 ──────────────────────

  /**
   * 处理 HTTP Upgrade 请求（WebSocket 握手）。
   */
  private _onUpgrade(req: IncomingMessage, socket: any, head: Buffer): void {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (url.pathname !== this.config.wsPath) {
      socket.destroy()
      return
    }

    const key = req.headers['sec-websocket-key'] as string
    if (!key) {
      socket.destroy()
      return
    }

    // WebSocket 握手
    const acceptKey = this._generateAcceptKey(key)
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '',
      '',
    ].join('\r\n')

    socket.write(responseHeaders)

    // 创建客户端
    const clientId = `ws-${++this.clientIdCounter}`
    let buffer = Buffer.alloc(0)

    const client: WsClient = {
      id: clientId,
      send: (data: string) => {
        try {
          const frame = encodeWsFrame(data)
          socket.write(frame)
        } catch (err) {
          this.logger.warn(`WebSocket send error for ${clientId}: ${(err as Error).message}`)
        }
      },
      close: () => {
        try { socket.destroy() } catch { /* ignore */ }
      },
      connectedAt: Date.now(),
    }

    this.wsClients.set(clientId, client)
    this.logger.info(`WebSocket client connected: ${clientId}`)

    // 处理数据
    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data])
      for (;;) {
        const frame = parseWsFrame(buffer)
        if (!frame) break
        buffer = buffer.subarray(frame.payload.length + 2 + (frame.payload.length >= 126 ? 2 : 0) + (frame.payload.length >= 65536 ? 8 : 0))

        if (frame.opcode === 0x08) {
          // Close frame
          this._removeWsClient(clientId)
          return
        }

        if (frame.opcode === 0x09) {
          // Ping → Pong
          const pong = Buffer.alloc(2)
          pong[0] = 0x8a
          pong[1] = 0x00
          socket.write(pong)
          continue
        }

        if (frame.opcode === 0x01) {
          // Text frame
          const text = frame.payload.toString('utf-8')
          this._handleWsMessage(clientId, text)
        }
      }
    })

    socket.on('close', () => {
      this._removeWsClient(clientId)
    })

    socket.on('error', () => {
      this._removeWsClient(clientId)
    })
  }

  /**
   * 处理 WebSocket 消息。
   */
  private _handleWsMessage(clientId: string, text: string): void {
    try {
      const msg = JSON.parse(text) as WsSubscribeMessage
      if (msg.type === 'subscribe' && msg.filter) {
        const client = this.wsClients.get(clientId)
        if (client) {
          client.filter = msg.filter
          this.logger.info(`WebSocket client ${clientId} subscribed with filter:`, { filter: msg.filter })
        }
      }
    } catch {
      // 非 JSON 消息忽略
    }
  }

  /**
   * 移除 WebSocket 客户端。
   */
  private _removeWsClient(clientId: string): void {
    this.wsClients.delete(clientId)
  }

  /**
   * 生成 WebSocket 握手 accept key。
   */
  private _generateAcceptKey(key: string): string {
    const crypto = require('crypto')
    const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
    const sha1 = crypto.createHash('sha1').update(key + GUID).digest('base64')
    return sha1
  }

  // ── HTTP Long-Polling ──────────────────

  /**
   * 处理 HTTP Long-Polling 请求。
   */
  private _handleLongPolling(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const sinceStr = url.searchParams.get('since')
    const sinceSeq = sinceStr ? parseInt(sinceStr, 10) : 0
    const labels = url.searchParams.get('labels')?.split(',').filter(Boolean)
    const ops = url.searchParams.get('ops')?.split(',').filter(Boolean) as any[] | undefined

    const filter: CdcFilter = {}
    if (labels && labels.length > 0) filter.labels = labels
    if (ops && ops.length > 0) filter.ops = ops

    // 立即检查是否有可用事件
    const events = this.adapter.querySince(sinceSeq, filter)
    if (events.length > 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(events))
      return
    }

    // 没有新事件，hold 连接
    const pollId = ++this.longPollTimerId
    const timer = setTimeout(() => {
      // 超时返回空数组
      const idx = this.pendingPolls.findIndex(p => p.timer as any === pollId)
      if (idx !== -1) this.pendingPolls.splice(idx, 1)
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('[]')
      } catch { /* ignore */ }
    }, this.config.longPollTimeoutMs!)

    // 使用 timer 引用关联 poll
    const pollEntry = { res, filter, sinceSeq, timer }
    this.pendingPolls.push(pollEntry)

    // 如果连接断开，清理
    req.on('close', () => {
      clearTimeout(timer)
      const idx = this.pendingPolls.indexOf(pollEntry)
      if (idx !== -1) this.pendingPolls.splice(idx, 1)
    })
  }

  // ── CDC 事件分发 ──────────────────────

  /**
   * 当 CDC 事件发生时调用。
   * 将事件分发到 WebSocket 客户端、Long-Polling 响应和 Webhook。
   */
  private _onCdcEvent(event: CdcEvent): void {
    // 1. WebSocket 推送
    const json = JSON.stringify(event)
    for (const [, client] of this.wsClients) {
      if (this._matchesWsFilter(event, client.filter)) {
        client.send(json)
      }
    }

    // 2. Long-Polling 响应
    for (let i = this.pendingPolls.length - 1; i >= 0; i--) {
      const poll = this.pendingPolls[i]
      clearTimeout(poll.timer)
      // 粗略过滤 labels/ops
      let matched = true
      if (poll.filter?.ops && poll.filter.ops.length > 0) {
        if (!poll.filter.ops.includes(event.op)) matched = false
      }
      if (matched) {
        this.pendingPolls.splice(i, 1)
        try {
          poll.res.writeHead(200, { 'Content-Type': 'application/json' })
          poll.res.end(JSON.stringify([event]))
        } catch { /* ignore */ }
      } else {
        // 重新设置超时（放弃未匹配的 poll）
        poll.timer = setTimeout(() => {
          const idx = this.pendingPolls.indexOf(poll)
          if (idx !== -1) this.pendingPolls.splice(idx, 1)
          try {
            poll.res.writeHead(200, { 'Content-Type': 'application/json' })
            poll.res.end('[]')
          } catch { /* ignore */ }
        }, this.config.longPollTimeoutMs!)
      }
    }

    // 3. Webhook 推送（异步，不阻塞）
    if (this.config.webhookUrls && this.config.webhookUrls.length > 0) {
      this._pushWebhooks(event)
    }
  }

  /**
   * 检查 WebSocket 客户端的过滤条件。
   */
  private _matchesWsFilter(event: CdcEvent, filter?: CdcFilter): boolean {
    if (!filter) return true
    if (filter.ops && filter.ops.length > 0 && !filter.ops.includes(event.op)) return false
    if (filter.entities && filter.entities.length > 0 && !filter.entities.includes(event.entity)) return false
    return true
  }

  /**
   * 异步推送事件到所有 Webhook URL。
   */
  private _pushWebhooks(event: CdcEvent): void {
    const urls = this.config.webhookUrls!
    const body = JSON.stringify(event)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.webhookHeaders,
    }

    for (const url of urls) {
      this._postWebhook(url, body, headers)
    }
  }

  /**
   * POST 事件到单个 Webhook URL。
   */
  private _postWebhook(
    urlStr: string,
    body: string,
    headers: Record<string, string>,
  ): void {
    try {
      const url = new URL(urlStr)
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(body).toString(),
        },
      }

      const proto = url.protocol === 'https:' ? require('https') : http
      const req = proto.request(options, (res: any) => {
        // 消费响应体
        let data = ''
        res.on('data', (chunk: string) => { data += chunk })
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            this.logger.warn(`Webhook POST ${urlStr} returned ${res.statusCode}: ${data}`)
          }
        })
      })
      req.on('error', (err: Error) => {
        this.logger.warn(`Webhook POST ${urlStr} error: ${err.message}`)
      })
      req.write(body)
      req.end()
    } catch (err) {
      this.logger.warn(`Invalid webhook URL ${urlStr}: ${(err as Error).message}`)
    }
  }
}
