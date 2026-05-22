/**
 * RaftTransport — 进程内 Mock 传输层
 *
 * 用于开发和测试环境，模拟 3/5/7 节点 Raft 集群的通讯
 * 生产环境应替换为 TCP/gRPC 传输
 */
import * as net from 'node:net'
import * as os from 'node:os'

interface MessageHandler {
  (from: string, msg: Uint8Array): void
}

interface MockNodeRegistry {
  listeners: Map<string, MessageHandler>
}

const globalRegistry: MockNodeRegistry = {
  listeners: new Map(),
}

export class MockTransport {
  private nodeId: string
  private handler: MessageHandler | null = null

  constructor(nodeId?: string) {
    this.nodeId = nodeId || 'unknown'
  }

  setNodeId(id: string): void {
    this.nodeId = id
  }

  async send(to: string, msg: Uint8Array): Promise<void> {
    const handler = globalRegistry.listeners.get(to)
    if (handler) {
      // 异步发送以模拟网络延迟
      setImmediate(() => {
        handler(this.nodeId, msg)
      })
    }
  }

  recv(onMessage: (from: string, msg: Uint8Array) => void): void {
    this.handler = onMessage
    globalRegistry.listeners.set(this.nodeId, onMessage)
  }

  close(): void {
    globalRegistry.listeners.delete(this.nodeId)
    this.handler = null
  }

  /** 清除所有注册的节点（测试辅助） */
  static reset(): void {
    globalRegistry.listeners.clear()
  }

  /** 获取已注册节点数 */
  static get registeredCount(): number {
    return globalRegistry.listeners.size
  }
}

// ─── TcpTransport ──────────────────────────────────────────────

/** JSON 帧格式：{"from":"node-1","data":"...base64...","type":"raft"} */
interface TcpFrame {
  from: string
  data: string // base64-encoded Uint8Array
  type?: string
}

/** 全局 TCP 端口注册表（用于测试和集群管理等场景） */
const globalTcpPorts: Map<string, number> = new Map() // nodeId → port

/**
 * TcpTransport — 生产环境 TCP 传输层
 *
 * 使用 Node.js 内置 `net` 模块，零外部依赖。
 * 消息协议：4-byte big-endian length prefix + UTF-8 JSON。
 *
 * 用法：
 * ```ts
 * const transport = new TcpTransport('node-1', 0) // port 0 = OS 分配
 * transport.setMessageHandler((from, msg) => { ... })
 * transport.start()
 * transport.connectTo('node-2:9001')
 * transport.sendTo('node-2', Buffer.from('hello'))
 * ```
 */
export class TcpTransport {
  private nodeId: string
  private port: number
  private handler: ((from: string, msg: Uint8Array) => void) | null = null
  private server: net.Server | null = null
  private connections: Map<string, net.Socket> = new Map() // peerId → socket
  private peerAddresses: Map<string, string> = new Map() // peerId → "host:port"
  private listenAddress: string = ''

  constructor(nodeId?: string, port?: number) {
    this.nodeId = nodeId || `tcp-${process.pid}`
    this.port = port ?? 0
  }

  // ── 公共接口 ────────────────────────────────────────────────

  setNodeId(id: string): void {
    this.nodeId = id
  }

  setMessageHandler(handler: (from: string, msg: Uint8Array) => void): void {
    this.handler = handler
  }

  /** 连接到对等节点 */
  connectTo(peerAddress: string): boolean {
    // peerAddress 格式: "nodeId:host:port" 或 "host:port"
    const parts = peerAddress.split(':')
    if (parts.length < 2) return false

    let peerId: string
    let host: string = ''
    let port: number = 0

    if (parts.length >= 3) {
      // "nodeId:host:port"
      peerId = parts[0]
      host = parts[1]
      port = parseInt(parts[2], 10)
    } else {
      // "host:port"
      host = parts[0]
      port = parseInt(parts[1], 10)
      peerId = `${host}:${port}`
    }

    if (isNaN(port)) return false
    this.peerAddresses.set(peerId, `${host}:${port}`)
    this._connectToPeer(peerId, host, port, 1) // 异步连接
    return true
  }

  /** 发送消息到指定节点 */
  sendTo(peerId: string, msg: Uint8Array): boolean {
    const socket = this.connections.get(peerId)
    if (!socket || socket.destroyed || !socket.writable) {
      // 如果连接不存在，尝试重新连接
      const addr = this.peerAddresses.get(peerId)
      if (addr) {
        const [host, portStr] = addr.split(':')
        const port = parseInt(portStr, 10)
        if (!isNaN(port)) {
          this._connectToPeer(peerId, host, port, 1)
        }
      }
      return false
    }

    try {
      this._writeFrame(socket, msg)
      return true
    } catch {
      return false
    }
  }

  /** 广播到所有已知节点 */
  broadcast(msg: Uint8Array): void {
    for (const peerId of this.connections.keys()) {
      this.sendTo(peerId, msg)
    }
  }

  /** 启动 TCP server */
  start(): void {
    if (this.server) return

    this.server = net.createServer((socket) => {
      this._handleConnection(socket)
    })

    this.server.listen(this.port)

    // port 0 时 OS 动态分配，同步获取已监听端口
    const addr = this.server.address()
    if (addr && typeof addr === 'object') {
      this.port = addr.port
    }
    this.listenAddress = `${this._getLocalIp()}:${this.port}`
    globalTcpPorts.set(this.nodeId, this.port)
  }

  /** 停止 server 并关闭所有连接 */
  stop(): void {
    // 关闭所有 socket
    for (const [peerId, socket] of this.connections) {
      socket.destroy()
    }
    this.connections.clear()
    this.peerAddresses.clear()

    // 关闭 server
    if (this.server) {
      this.server.close()
      this.server = null
    }

    // 从全局注册表移除
    globalTcpPorts.delete(this.nodeId)
  }

  /** 静态注册：设置全局端口 */
  static register(port: number): void {
    // 这个方法是给集群管理器用的，记录默认 TCP 端口
    // 具体节点绑定通过 NodeId→port 映射
    process.env.TCP_TRANSPORT_PORT = String(port)
  }

  /** 清除全局注册表 (测试辅助) */
  static reset(): void {
    globalTcpPorts.clear()
  }

  /** 获取本节点实际监听端口 */
  getPort(): number {
    return this.port
  }

  /** 获取本节点监听地址 */
  getListenAddress(): string {
    return this.listenAddress
  }

  // ── 内部实现 ────────────────────────────────────────────────

  /** 写一个 JSON 帧到 socket */
  private _writeFrame(socket: net.Socket, msg: Uint8Array): void {
    const base64Data = Buffer.from(msg).toString('base64')
    const frame: TcpFrame = {
      from: this.nodeId,
      data: base64Data,
      type: 'raft',
    }
    const json = JSON.stringify(frame)
    const jsonBuf = Buffer.from(json, 'utf-8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(jsonBuf.length, 0)
    socket.write(Buffer.concat([header, jsonBuf]))
  }

  /** 处理新连接 */
  private _handleConnection(socket: net.Socket): void {
    socket.setKeepAlive(true, 5000)
    let buffer = Buffer.alloc(0)

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])

      // 尝试解析完整的帧
      while (buffer.length >= 4) {
        const frameLen = buffer.readUInt32BE(0)
        const totalLen = 4 + frameLen
        if (buffer.length < totalLen) break

        const frameJson = buffer.subarray(4, totalLen).toString('utf-8')
        buffer = buffer.subarray(totalLen)

        try {
          const frame: TcpFrame = JSON.parse(frameJson)
          if (frame.from && frame.data) {
            const h = this.handler
            if (h) {
              h(frame.from, Buffer.from(frame.data, 'base64'))
            }
          }
        } catch {
          // 忽略无法解析的帧
        }
      }
    })

    socket.on('close', () => {
      // 从连接池中移除（通过反向查找）
      for (const [peerId, s] of this.connections) {
        if (s === socket) {
          this.connections.delete(peerId)
          break
        }
      }
    })

    socket.on('error', () => {
      socket.destroy()
    })
  }

  /** 连接到对等节点，带重试 */
  private _connectToPeer(
    peerId: string,
    host: string,
    port: number,
    attempt: number,
  ): void {
    // 避免重复连接
    if (this.connections.has(peerId)) return

    const socket = new net.Socket()

    const cleanup = () => {
      this.connections.delete(peerId)
    }

    socket.on('connect', () => {
      socket.setKeepAlive(true, 5000)
      this.connections.set(peerId, socket)
    })

    socket.on('close', () => {
      cleanup()
    })

    socket.on('error', () => {
      cleanup()
      socket.destroy()
    })

    const maxAttempts = 3
    socket.connect(port, host, () => {
      // 连接成功后，用相反方向注册
      // （连接发起方的 socket 也需要接收数据）
      this._handleConnection(socket)
    })

    // 处理连接失败重试
    socket.on('error', () => {
      if (attempt < maxAttempts) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000)
        setTimeout(() => {
          this._connectToPeer(peerId, host, port, attempt + 1)
        }, delay)
      }
    })
  }

  /** 获取本地 IP（优先 IPv4） */
  private _getLocalIp(): string {
    const interfaces = os.networkInterfaces()
    for (const name of Object.keys(interfaces)) {
      const ifaces = interfaces[name]
      if (!ifaces) continue
      for (const iface of ifaces) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address
        }
      }
    }
    return '127.0.0.1'
  }
}
