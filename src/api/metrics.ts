/**
 * metrics.ts — Prometheus 指标导出端点
 *
 * 暴露 GET /metrics 端点，返回以下 GraphVec Prometheus 指标：
 *   - graphvec_query_count (counter) — 查询总数
 *   - graphvec_active_connections (gauge) — 当前活跃连接
 *   - graphvec_memory_usage_mb (gauge) — 内存使用 (MB)
 *
 * 该模块不依赖 Express Router，直接返回原生 HTTP 请求处理函数，
 * 与 GraphVec 现有 rest.ts 的架构风格一致。
 */

import { register, Counter, Gauge } from 'prom-client'
import type { IncomingMessage, ServerResponse } from 'http'

const PREFIX = 'graphvec_'

/**
 * 全局 prom-client 指标注册（懒加载，仅首次调用时创建）。
 */
let _queryCount: Counter<string> | null = null
let _activeConnections: Gauge<string> | null = null
let _memoryUsage: Gauge<string> | null = null

function ensureMetrics(): void {
  if (_queryCount) return

  _queryCount = new Counter({
    name: `${PREFIX}query_count`,
    help: '查询总数',
    registers: [register],
  })

  _activeConnections = new Gauge({
    name: `${PREFIX}active_connections`,
    help: '当前活跃连接',
    registers: [register],
  })

  _memoryUsage = new Gauge({
    name: `${PREFIX}memory_usage_mb`,
    help: '内存使用',
    registers: [register],
  })
}

/**
 * 返回 prom-client 注册表（用于集成到 rest.ts 等现有 HTTP 服务）。
 */
export function getRegistry(): typeof register {
  ensureMetrics()
  return register
}

/**
 * 增加查询计数。
 */
export function incrementQueryCount(delta: number = 1): void {
  ensureMetrics()
  _queryCount!.inc(delta)
}

/**
 * 设置活跃连接数。
 */
export function setActiveConnections(count: number): void {
  ensureMetrics()
  _activeConnections!.set(count)
}

/**
 * 设置内存使用 (MB)。
 */
export function setMemoryUsageMB(mb: number): void {
  ensureMetrics()
  _memoryUsage!.set(mb)
}

/**
 * 获取当前内存使用 (MB)。
 */
export function getMemoryUsageMB(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
}

/**
 * 生成 Prometheus 格式的指标文本。
 */
export async function getMetricsText(): Promise<string> {
  ensureMetrics()
  // 每次输出前更新动态变量
  setMemoryUsageMB(getMemoryUsageMB())
  return register.metrics()
}

/**
 * 获取 Prometheus text/plain Content-Type 值。
 */
export function getMetricsContentType(): string {
  ensureMetrics()
  return register.contentType
}

/**
 * HTTP 请求处理函数 — 处理 GET /metrics 请求。
 *
 * 用法（与 rest.ts 一致）：
 *   import { metricsHandler } from './api/metrics'
 *   server.on('request', (req, res) => {
 *     if (req.url === '/metrics') return metricsHandler(req, res)
 *     // ...
 *   })
 */
export async function metricsHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await getMetricsText()
    res.writeHead(200, {
      'Content-Type': getMetricsContentType(),
      'Content-Length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch (err) {
    res.writeHead(500).end('Internal Server Error')
  }
}

/**
 * 重置所有指标（测试用）。
 */
export function resetMetrics(): void {
  register.clear()
  _queryCount = null
  _activeConnections = null
  _memoryUsage = null
}
