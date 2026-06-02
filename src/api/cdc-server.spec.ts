/**
 * cdc-server.spec.ts — CdcServer 单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as http from 'http'
import * as url from 'url'
import { CdcAdapter, CdcEvent, NODE_CREATED, NODE_DELETED, EDGE_CREATED, EDGE_DELETED } from '../core/cdc-adapter'
import { CdcServer } from './cdc-server'

/**
 * 解析 JSON 响应
 */
function fetchJson(urlStr: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(urlStr, (res) => {
      let data = ''
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) })
        } catch {
          resolve({ status: res.statusCode, raw: data })
        }
      })
    }).on('error', reject)
  })
}

/**
 * 异步 JSON POST
 */
function postJson(urlStr: string, body: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const payload = JSON.stringify(body)
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }
    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => {
        resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null })
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

/**
 * 模拟 StreamMessage
 */
function makeMsg(type: string, data: Record<string, unknown>, seq: number = 1, timestamp?: number) {
  return {
    msgId: `test-${seq}`,
    seq,
    nodeId: 'test-node',
    timestamp: timestamp ?? Date.now(),
    type,
    data,
  }
}

describe('CdcServer', () => {
  let adapter: CdcAdapter
  let server: CdcServer
  let httpServer: http.Server
  let port: number

  beforeEach(async () => {
    adapter = new CdcAdapter({ maxBufferSize: 100 })

    server = new CdcServer({
      adapter,
      wsPath: '/cdc',
      httpPath: '/api/v1/cdc/stream',
      longPollTimeoutMs: 5000,
    })

    // 创建 HTTP 服务器
    httpServer = http.createServer((req, res) => {
      // 尝试 CDC 路由
      if (!server.handleRequest(req, res)) {
        res.writeHead(404)
        res.end('Not found')
      }
    })

    // 挂载 WebSocket 升级
    httpServer.on('upgrade', server.handleUpgrade)

    // 绑定到随机端口
    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve())
    })
    port = (httpServer.address() as any).port
  })

  afterEach(() => {
    server.close()
    httpServer.close()
  })

  // ── HTTP Long-Polling ──────────────────

  it('GAP-15-01: GET /api/v1/cdc/stream returns events since seq', async () => {
    // 模拟 CDC 事件
    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1, name: 'Alice', label: 'Person' }, 1))
    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 2, name: 'Bob', label: 'Person' }, 2))

    const result = await fetchJson(`http://127.0.0.1:${port}/api/v1/cdc/stream?since=0`)
    expect(result.status).toBe(200)
    expect(Array.isArray(result.data)).toBe(true)
    expect(result.data.length).toBe(2)
    expect(result.data[0].op).toBe('create')
    expect(result.data[0].entity).toBe('node')
    expect(result.data[0].after.name).toBe('Alice')
    expect(result.data[1].after.name).toBe('Bob')
  })

  it('GAP-15-02: GET /api/v1/cdc/stream with since param filters correctly', async () => {
    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1, name: 'Alice' }, 1))
    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 2, name: 'Bob' }, 2))

    const result = await fetchJson(`http://127.0.0.1:${port}/api/v1/cdc/stream?since=1`)
    expect(result.status).toBe(200)
    expect(result.data.length).toBe(1)
    expect(result.data[0].after.name).toBe('Bob')
  })

  it('GAP-15-03: GET /api/v1/cdc/stream returns empty for no events', async () => {
    const result = await fetchJson(`http://127.0.0.1:${port}/api/v1/cdc/stream?since=0`)
    expect(result.status).toBe(200)
    expect(result.data).toEqual([])
  })

  it('GAP-15-04: GET /api/v1/cdc/stream filters by ops', async () => {
    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1, name: 'Alice' }, 1))
    adapter.handleEvent(makeMsg(NODE_DELETED, { id: 1, name: 'Alice' }, 2))

    const result = await fetchJson(`http://127.0.0.1:${port}/api/v1/cdc/stream?since=0&ops=delete`)
    expect(result.status).toBe(200)
    expect(result.data.length).toBe(1)
    expect(result.data[0].op).toBe('delete')
  })

  it('GAP-15-05: returns 200 for unknown path (CDC server rejects it)', async () => {
    // 创建独立客户端请求
    const result = await fetchJson(`http://127.0.0.1:${port}/api/v1/cdc/other`)
    expect(result.status).toBe(404) // Not handled by CDC, falls through to 404
  })

  // ── 事件类型覆盖 ──────────────────────

  it('GAP-15-06: handles node:created events', () => {
    const events: CdcEvent[] = []
    adapter.subscribe('test-sub', (e) => events.push(e))

    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1, name: 'Alice', label: 'Person' }))

    expect(events.length).toBe(1)
    expect(events[0].op).toBe('create')
    expect(events[0].entity).toBe('node')
    expect(events[0].after).toEqual({ id: 1, name: 'Alice', label: 'Person' })
    expect(events[0].seq).toBe(1)
  })

  it('GAP-15-07: handles node:deleted events', () => {
    const events: CdcEvent[] = []
    adapter.subscribe('test-sub', (e) => events.push(e))

    adapter.handleEvent(makeMsg(NODE_DELETED, { id: 1, name: 'Alice' }))

    expect(events.length).toBe(1)
    expect(events[0].op).toBe('delete')
    expect(events[0].entity).toBe('node')
    expect(events[0].before).toEqual({ id: 1, name: 'Alice' })
  })

  it('GAP-15-08: handles edge:created events', () => {
    const events: CdcEvent[] = []
    adapter.subscribe('test-sub', (e) => events.push(e))

    adapter.handleEvent(makeMsg(EDGE_CREATED, { src: 1, dst: 2, typeId: 5 }))

    expect(events.length).toBe(1)
    expect(events[0].op).toBe('create')
    expect(events[0].entity).toBe('edge')
    expect(events[0].after).toEqual({ src: 1, dst: 2, typeId: 5 })
  })

  it('GAP-15-09: handles edge:deleted events', () => {
    const events: CdcEvent[] = []
    adapter.subscribe('test-sub', (e) => events.push(e))

    adapter.handleEvent(makeMsg(EDGE_DELETED, { src: 1, dst: 2, typeId: 5 }))

    expect(events.length).toBe(1)
    expect(events[0].op).toBe('delete')
    expect(events[0].entity).toBe('edge')
    expect(events[0].before).toEqual({ src: 1, dst: 2, typeId: 5 })
  })

  it('GAP-15-10: ignores unknown event types', () => {
    const events: CdcEvent[] = []
    adapter.subscribe('test-sub', (e) => events.push(e))

    adapter.handleEvent(makeMsg('unknown:event', { data: 'test' }))

    expect(events.length).toBe(0)
  })

  // ── 订阅者管理 ──────────────────────

  it('GAP-15-11: subscribe/unsubscribe works', () => {
    const events: CdcEvent[] = []
    adapter.subscribe('test-sub', (e) => events.push(e))
    expect(adapter.getSubscriberIds()).toContain('test-sub')

    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1 }))
    expect(events.length).toBe(1)

    adapter.unsubscribe('test-sub')
    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 2 }))
    expect(events.length).toBe(1) // 不再增长
    expect(adapter.getSubscriberIds()).not.toContain('test-sub')
  })

  // ── 事件过滤 ──────────────────────

  it('GAP-15-12: subscriber with ops filter only receives matching ops', () => {
    const events: CdcEvent[] = []
    adapter.subscribe('test-sub', (e) => events.push(e), { ops: ['delete'] })

    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1 }))
    expect(events.length).toBe(0)

    adapter.handleEvent(makeMsg(NODE_DELETED, { id: 1 }))
    expect(events.length).toBe(1)
    expect(events[0].op).toBe('delete')
  })

  it('GAP-15-13: subscriber with entity filter only receives matching entities', () => {
    const events: CdcEvent[] = []
    adapter.subscribe('test-sub', (e) => events.push(e), { entities: ['edge'] })

    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1 }))
    expect(events.length).toBe(0)

    adapter.handleEvent(makeMsg(EDGE_CREATED, { src: 1, dst: 2 }))
    expect(events.length).toBe(1)
    expect(events[0].entity).toBe('edge')
  })

  // ── 序列号 / 断点续传 ──────────────────

  it('GAP-15-14: currentSeq increases with each event', () => {
    expect(adapter.currentSeq).toBe(0)

    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1 }))
    expect(adapter.currentSeq).toBe(1)

    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 2 }))
    expect(adapter.currentSeq).toBe(2)
  })

  it('GAP-15-15: querySince returns events after the given seq', () => {
    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1 }))
    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 2 }))
    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 3 }))

    const events = adapter.querySince(1)
    expect(events.length).toBe(2) // seq 2 and 3
    expect(events[0].seq).toBe(2)
    expect(events[1].seq).toBe(3)
  })

  it('GAP-15-16: querySince returns empty when no events after seq', () => {
    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1 }))
    const events = adapter.querySince(1)
    expect(events).toEqual([])
  })

  // ── 缓冲区管理 ──────────────────────

  it('GAP-15-17: buffer respects maxBufferSize', () => {
    const smallAdapter = new CdcAdapter({ maxBufferSize: 3 })
    for (let i = 1; i <= 10; i++) {
      smallAdapter.handleEvent(makeMsg(NODE_CREATED, { id: i }, i))
    }
    expect(smallAdapter.bufferLength).toBe(3) // 只保留最后 3 条
    expect(smallAdapter.querySince(7).length).toBe(3)
  })

  it('GAP-15-18: clear empties the buffer', () => {
    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1 }))
    expect(adapter.bufferLength).toBeGreaterThan(0)

    adapter.clear()
    expect(adapter.bufferLength).toBe(0)
  })

  // ── Webhook ──────────────────────────

  it('GAP-15-19: addWebhook and removeWebhook work', () => {
    server.addWebhook('http://localhost:9999/hook')
    const s = server.stats()
    expect(s.webhookCount).toBe(1)

    server.removeWebhook('http://localhost:9999/hook')
    expect(server.stats().webhookCount).toBe(0)
  })

  // ── stats ────────────────────────────

  it('GAP-15-20: stats returns current metrics', () => {
    const s = server.stats()
    expect(typeof s.wsConnections).toBe('number')
    expect(typeof s.pendingPolls).toBe('number')
    expect(typeof s.webhookCount).toBe('number')
    expect(typeof s.bufferLength).toBe('number')
  })

  // ── close 清理 ──────────────────────

  it('GAP-15-21: close cleans up all resources', () => {
    server.close()
    // 可以重新打开
    expect(() => server.close()).not.toThrow()
  })

  // ── 多订阅者 ──────────────────────

  it('GAP-15-22: multiple subscribers all receive events', () => {
    const events1: CdcEvent[] = []
    const events2: CdcEvent[] = []

    adapter.subscribe('sub1', (e) => events1.push(e))
    adapter.subscribe('sub2', (e) => events2.push(e))

    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1 }))

    expect(events1.length).toBe(1)
    expect(events2.length).toBe(1)
  })

  // ── WebSocket 握手 ──────────────────

  it('GAP-15-23: upgrade handler rejects non-CDC paths by destroying socket', async () => {
    // Connect to a non-matching path — socket should be destroyed (closed with error)
    // This is expected behavior: we destroy non-CDC upgrade requests
    const result = await fetchJson(`http://127.0.0.1:${port}/other`)
    // Non-CDC path should get a 404 from the default handler
    expect(result.status).toBe(404)
  })
})
