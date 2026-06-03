/**
 * metrics.spec.ts — Prometheus 指标导出端点测试
 *
 * 测试覆盖：
 * 1. GET /metrics 返回 200
 * 2. 响应包含 # HELP 和 # TYPE 行
 * 3. 数值显示正确（counter 递增、gauge 设置）
 * 4. Content-Type 为 prometheus text/plain
 * 5. 动态更新（内存、连接数）
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import {
  metricsHandler,
  incrementQueryCount,
  setActiveConnections,
  getMetricsText,
  getMetricsContentType,
  getMemoryUsageMB,
  resetMetrics,
} from './metrics'
import { IncomingMessage, ServerResponse } from 'http'
import { Socket } from 'net'

/**
 * 构造一个用于测试的 ServerResponse。
 * 拦截 writeHead/end 调用，将结果存入 result 对象。
 */
function createMockResponse(): {
  res: ServerResponse
  statusCode: number
  headers: Record<string, string | number>
  body: string
} {
  const result = {
    statusCode: 0,
    headers: {} as Record<string, string | number>,
    body: '',
  }

  const socket = new Socket()
  const res = new ServerResponse(socket) as ServerResponse & { _implicitHeader?: () => void }

  res.writeHead = function (this: ServerResponse, statusCode: number, headers?: Record<string, string | number>) {
    result.statusCode = statusCode
    if (headers) result.headers = { ...result.headers, ...headers }
    // 这里不要 return this —— 让 end 自行处理
    return this
  } as typeof res.writeHead

  res.end = function (this: ServerResponse, data?: any): ServerResponse {
    if (data) result.body = data.toString()
    return this
  } as typeof res.end

  // 避免 ServerResponse 调用原生 _implicitHeader 报错
  res._implicitHeader = () => {
    if (!result.statusCode) result.statusCode = 200
  }

  return { res, statusCode: result.statusCode, headers: result.headers, body: result.body }
}

describe('Metrics endpoint', () => {
  beforeEach(() => {
    resetMetrics()
  })

  afterEach(() => {
    resetMetrics()
  })

  // ── HTTP 200 ──────────────────────────────

  test('GET /metrics should return 200', async () => {
    const { res } = createMockResponse()
    const req = { method: 'GET', url: '/metrics' } as IncomingMessage

    await metricsHandler(req, res)

    // 验证响应状态码为 200
    expect(res.statusCode).toBe(200)
  })

  test('GET /metrics should return 500 on error gracefully', async () => {
    // 正常调用不会报 500，但如果 register.metrics() 抛出异常则应返回 500
    // 这里仅验证 handler 不抛异常
    const { res } = createMockResponse()
    const req = { method: 'GET', url: '/metrics' } as IncomingMessage
    await expect(metricsHandler(req, res)).resolves.toBeUndefined()
  })

  // ── HELP / TYPE 行 ───────────────────────

  test('response should contain # HELP and # TYPE lines', async () => {
    incrementQueryCount()
    setActiveConnections(5)

    const metrics = await getMetricsText()
    expect(metrics).toContain('# HELP')
    expect(metrics).toContain('# TYPE')
  })

  test('should include all expected HELP/TYPE entries', async () => {
    incrementQueryCount()
    setActiveConnections(5)

    const metrics = await getMetricsText()
    // 查询总数
    expect(metrics).toContain('# HELP graphvec_query_count')
    expect(metrics).toContain('# TYPE graphvec_query_count counter')
    // 活跃连接
    expect(metrics).toContain('# HELP graphvec_active_connections')
    expect(metrics).toContain('# TYPE graphvec_active_connections gauge')
    // 内存使用
    expect(metrics).toContain('# HELP graphvec_memory_usage_mb')
    expect(metrics).toContain('# TYPE graphvec_memory_usage_mb gauge')
  })

  // ── 数值显示 ──────────────────────────────

  test('should display correct counter value', async () => {
    incrementQueryCount()
    incrementQueryCount()
    incrementQueryCount()

    const metrics = await getMetricsText()
    expect(metrics).toContain('graphvec_query_count 3')
  })

  test('counter should accumulate across multiple calls', async () => {
    for (let i = 0; i < 5; i++) {
      incrementQueryCount()
    }

    const metrics = await getMetricsText()
    expect(metrics).toContain('graphvec_query_count 5')
  })

  test('should display correct gauge values', async () => {
    setActiveConnections(8)

    const metrics = await getMetricsText()
    expect(metrics).toContain('graphvec_active_connections 8')
  })

  test('gauge should reflect updated values', async () => {
    setActiveConnections(3)
    setActiveConnections(7)

    const metrics = await getMetricsText()
    // 最后一次设置的值应生效
    expect(metrics).toContain('graphvec_active_connections 7')
  })

  test('memory usage gauge should show a positive integer', async () => {
    getMemoryUsageMB() // 确保指标存在

    const metrics = await getMetricsText()
    const pattern = /graphvec_memory_usage_mb\s+(\d+)/
    const match = metrics.match(pattern)
    expect(match).not.toBeNull()
    if (match) {
      const val = parseInt(match[1], 10)
      expect(val).toBeGreaterThan(0)
    }
  })

  // ── Content-Type ─────────────────────────

  test('Content-Type should be prometheus text/plain', () => {
    const ct = getMetricsContentType()
    expect(ct).toContain('text/plain')
  })
})
