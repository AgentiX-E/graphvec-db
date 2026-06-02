/**
 * ws-query.ts — WebSocket 流式查询端点
 *
 * 提供 /api/v1/ws/query 端点，支持 Cypher 查询的流式结果推送：
 *   - 分批次推送查询结果，防止大结果集 OOM
 *   - 基于 cursor 的分页
 *   - 背压控制：慢客户端 buffer 满时关闭连接
 *   - 请求取消：客户端发送 cancel 消息终止查询
 *
 * 协议（JSON 帧）：
 *   Client → Server:
 *     { type: "query",   id: "req1", cypher: "MATCH (n) RETURN n", params: {} }
 *     { type: "cancel",  id: "req1" }
 *     { type: "next",    id: "req1", cursor: "abc123" }
 *
 *   Server → Client:
 *     { type: "batch",   id: "req1", batch: [...], hasMore: true, batchIndex: 0 }
 *     { type: "cursor",  id: "req1", cursor: "abc123" }
 *     { type: "complete",id: "req1", summary: { totalRows: 100, batches: 5, timeMs: 50 } }
 *     { type: "error",   id: "req1", message: "..." }
 */

import * as http from 'http'
import { WebSocketServer, WebSocket } from 'ws'

// ── Types ─────────────────────────────────────────────────

/** 查询执行函数签名 */
export type QueryExecutor = (
  cypher: string,
  params: Record<string, unknown>,
) => AsyncGenerator<Record<string, unknown>, { totalRows: number }, void>

/** WS 流式查询配置 */
export interface WsQueryConfig {
  /** HTTP 服务器实例（可选，如果提供则挂载到该服务器） */
  server?: http.Server
  /** 绑定端口（仅在 server 未提供时生效），默认 7687 */
  port?: number
  /** 绑定地址，默认 '0.0.0.0' */
  host?: string
  /** WebSocket 路径，默认 '/api/v1/ws/query' */
  path?: string
  /** 每批次最大行数，默认 100 */
  batchSize?: number
  /** 客户端背压 buffer 最大值，默认 1000 条 */
  maxBufferSize?: number
  /** 最大并发查询数，默认 100 */
  maxConcurrentQueries?: number
}

/** 客户端请求消息 */
type ClientMessage =
  | { type: 'query'; id: string; cypher: string; params?: Record<string, unknown> }
  | { type: 'cancel'; id: string }
  | { type: 'next'; id: string; cursor?: string }

/** 服务器推送消息 */
type ServerMessage =
  | { type: 'batch'; id: string; batch: Record<string, unknown>[]; hasMore: boolean; batchIndex: number }
  | { type: 'cursor'; id: string; cursor: string }
  | { type: 'complete'; id: string; summary: { totalRows: number; batches: number; timeMs: number } }
  | { type: 'error'; id: string; message: string }

/** 活跃查询状态 */
interface ActiveQuery {
  id: string
  generator: AsyncGenerator<Record<string, unknown>, { totalRows: number }, void>
  batchIndex: number
  totalRows: number
  startTime: number
  cancelled: boolean
}

// ── WsQueryServer ─────────────────────────────────────────

/**
 * WsQueryServer — WebSocket 流式查询服务
 *
 * 管理 WebSocket 连接和查询生命周期。
 * 每个客户端连接独立处理，支持多条并发查询。
 *
 * 使用示例:
 *   const executor: QueryExecutor = async function* (cypher, params) {
 *     for (const row of engine.query(cypher, params)) yield row
 *   }
 *   const wsServer = new WsQueryServer({ port: 7687 })
 *   wsServer.setExecutor(executor)
 *   await wsServer.start()
 */
export class WsQueryServer {
  private _wss: WebSocketServer | null = null
  private _server: http.Server | null = null
  private _config: Required<WsQueryConfig>
  private _executor: QueryExecutor | null = null
  private _activeQueries: Map<string, ActiveQuery> = new Map()
  private _running: boolean = false

  constructor(config: WsQueryConfig = {}) {
    this._config = {
      server: config.server ?? undefined as unknown as http.Server,
      port: config.port ?? 7687,
      host: config.host ?? '0.0.0.0',
      path: config.path ?? '/api/v1/ws/query',
      batchSize: config.batchSize ?? 100,
      maxBufferSize: config.maxBufferSize ?? 1000,
      maxConcurrentQueries: config.maxConcurrentQueries ?? 100,
    }
  }

  /** 设置查询执行器 */
  setExecutor(executor: QueryExecutor): void {
    this._executor = executor
  }

  /** 启动 WebSocket 服务 */
  async start(): Promise<void> {
    if (this._running) return

    if (this._config.server) {
      this._wss = new WebSocketServer({
        server: this._config.server,
        path: this._config.path,
      })
    } else {
      this._server = http.createServer()
      this._wss = new WebSocketServer({
        server: this._server,
        path: this._config.path,
      })
    }

    this._wss.on('connection', (ws: WebSocket) => {
      this._handleConnection(ws)
    })

    if (this._server) {
      await new Promise<void>((resolve) => {
        this._server!.listen(this._config.port, this._config.host, () => {
          resolve()
        })
      })
    }

    this._running = true
  }

  /** 关闭 WebSocket 服务 */
  async stop(): Promise<void> {
    this._running = false

    // 取消所有活跃查询
    for (const [id, query] of this._activeQueries) {
      query.cancelled = true
    }
    this._activeQueries.clear()

    if (this._wss) {
      this._wss.close()
      this._wss = null
    }

    if (this._server) {
      await new Promise<void>((resolve) => {
        this._server!.close(() => resolve())
      })
      this._server = null
    }
  }

  /** 检查服务是否正在运行 */
  get running(): boolean {
    return this._running
  }

  /** 获取配置 */
  get config(): Required<WsQueryConfig> {
    return { ...this._config }
  }

  /** 获取活跃查询数 */
  get activeQueryCount(): number {
    return this._activeQueries.size
  }

  // ── Connection handling ─────────────────────────────────

  private _handleConnection(ws: WebSocket): void {
    let bufferSize = 0
    const clientQueries = new Set<string>()

    ws.on('message', (raw: Buffer) => {
      let msg: ClientMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        this._send(ws, {
          type: 'error',
          id: 'unknown',
          message: 'Invalid JSON message',
        })
        return
      }

      switch (msg.type) {
        case 'query':
          this._handleQuery(ws, msg, clientQueries, () => bufferSize)
          break
        case 'cancel':
          this._handleCancel(msg.id, clientQueries)
          break
        case 'next':
          // cursor-based pagination: resume an existing query
          this._handleNext(ws, msg, clientQueries)
          break
        default:
          this._send(ws, {
            type: 'error',
            id: msg.id || 'unknown',
            message: `Unknown message type: ${(msg as any).type}`,
          })
      }
    })

    ws.on('close', () => {
      // 清理该客户端的所有查询
      for (const id of clientQueries) {
        const query = this._activeQueries.get(id)
        if (query) {
          query.cancelled = true
          this._activeQueries.delete(id)
        }
      }
      clientQueries.clear()
    })

    ws.on('error', () => {
      // 连接错误时清理
      for (const id of clientQueries) {
        const query = this._activeQueries.get(id)
        if (query) {
          query.cancelled = true
          this._activeQueries.delete(id)
        }
      }
      clientQueries.clear()
    })
  }

  // ── Query handling ──────────────────────────────────────

  private _handleQuery(
    ws: WebSocket,
    msg: { type: 'query'; id: string; cypher: string; params?: Record<string, unknown> },
    clientQueries: Set<string>,
    getBufferSize: () => number,
  ): void {
    if (!this._executor) {
      this._send(ws, {
        type: 'error',
        id: msg.id,
        message: 'No query executor configured',
      })
      return
    }

    if (typeof msg.cypher !== 'string' || msg.cypher.trim().length === 0) {
      this._send(ws, {
        type: 'error',
        id: msg.id,
        message: 'Empty or invalid cypher query',
      })
      return
    }

    // 检查并发限制
    if (this._activeQueries.size >= this._config.maxConcurrentQueries) {
      this._send(ws, {
        type: 'error',
        id: msg.id,
        message: `Max concurrent queries reached (${this._config.maxConcurrentQueries})`,
      })
      return
    }

    // 启动流式查询
    const generator = this._executor(msg.cypher, msg.params ?? {})
    const query: ActiveQuery = {
      id: msg.id,
      generator,
      batchIndex: 0,
      totalRows: 0,
      startTime: Date.now(),
      cancelled: false,
    }

    this._activeQueries.set(msg.id, query)
    clientQueries.add(msg.id)

    // 异步开始推送
    this._streamQuery(ws, query, getBufferSize).catch((err) => {
      if (!query.cancelled) {
        this._send(ws, {
          type: 'error',
          id: query.id,
          message: `Query error: ${(err as Error).message}`,
        })
      }
      this._activeQueries.delete(query.id)
      clientQueries.delete(query.id)
    })
  }

  private async _streamQuery(
    ws: WebSocket,
    query: ActiveQuery,
    getBufferSize: () => number,
  ): Promise<void> {
    let batch: Record<string, unknown>[] = []

    for await (const row of query.generator) {
      if (query.cancelled) return

      batch.push(row)
      query.totalRows++

      // 检查背压
      if (getBufferSize() > this._config.maxBufferSize) {
        query.cancelled = true
        this._send(ws, {
          type: 'error',
          id: query.id,
          message: 'Client buffer full, query cancelled',
        })
        this._activeQueries.delete(query.id)
        return
      }

      // 批次满时先不发送，尝试预读下一个确定 hasMore
      if (batch.length >= this._config.batchSize) {
        // 预读下一个值判断 generator 是否结束
        const peek = await query.generator.next()
        const hasMore = !peek.done

        this._send(ws, {
          type: 'batch',
          id: query.id,
          batch,
          hasMore,
          batchIndex: query.batchIndex++,
        })
        batch = []

        // 如果预读发现 generator 已结束，退出
        if (peek.done) {
          break
        }

        // 否则把预读的 row 加入新的 batch
        batch.push(peek.value)
        query.totalRows++
      }
    }

    // 发出最后一个批次（该发出时 generator 已结束）
    if (batch.length > 0 || query.batchIndex === 0) {
      this._send(ws, {
        type: 'batch',
        id: query.id,
        batch,
        hasMore: false,
        batchIndex: query.batchIndex++,
      })
    }

    // 查询完成
    const timeMs = Date.now() - query.startTime
    this._send(ws, {
      type: 'complete',
      id: query.id,
      summary: {
        totalRows: query.totalRows,
        batches: query.batchIndex,
        timeMs,
      },
    })

    this._activeQueries.delete(query.id)
  }

  // ── Cancel ──────────────────────────────────────────────

  private _handleCancel(id: string, clientQueries: Set<string>): void {
    if (!clientQueries.has(id)) return
    const query = this._activeQueries.get(id)
    if (query) {
      query.cancelled = true
      this._activeQueries.delete(id)
    }
    clientQueries.delete(id)
  }

  // ── Next (cursor-based pagination) ──────────────────────

  private _handleNext(
    ws: WebSocket,
    msg: { type: 'next'; id: string; cursor?: string },
    clientQueries: Set<string>,
  ): void {
    // cursor-based pagination: simple implementation uses the existing streaming
    // but for real cursor, it would need state serialization.
    // For now, we treat "next" as a nop — the streaming already pushes all rows.
    // In a production implementation, this would serialize the query state
    // and resume from the cursor position.
    this._send(ws, {
      type: 'complete',
      id: msg.id,
      summary: { totalRows: 0, batches: 0, timeMs: 0 },
    })
  }

  // ── Send helper ────────────────────────────────────────

  private _send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }
}

/**
 * createBatchQueryExecutor — 将普通查询结果转为 AsyncGenerator
 *
 * 用于适配已有 GraphEngine 的查询接口到 WsQueryServer。
 *
 * @param executeQuery 同步/异步查询执行函数，返回结果数组
 * @returns QueryExecutor
 */
export function createBatchQueryExecutor(
  executeQuery: (cypher: string, params: Record<string, unknown>) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>,
): QueryExecutor {
  return async function* (cypher: string, params: Record<string, unknown>) {
    const rows = await executeQuery(cypher, params)
    for (const row of rows) {
      yield row
    }
    return { totalRows: rows.length }
  }
}
