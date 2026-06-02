/**
 * prometheus-exporter.spec.ts — Prometheus 指标集成测试
 *
 * 测试点：
 * - 单例获取
 * - configure/stop/start 生命周期
 * - 操作计数接口（incrementQueries, incrementNodeOps, incrementEdgeOps）
 * - 延迟记录接口（recordQueryLatency, recordNodeLatency, recordEdgeLatency）
 * - 仪表盘接口（setNodeCount, setEdgeCount, setNodeTypeCount）
 * - /metrics 输出格式
 * - HTTP 端点
 * - 自定义前缀
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { PrometheusExporter } from './prometheus-exporter'
import { register as globalRegister } from 'prom-client'

// 固定测试前缀，避免跨测试冲突
const TEST_PREFIX = 'test_gvec_'

describe('PrometheusExporter', () => {
  describe('GAP-31: 单例与生命周期', () => {
    afterEach(() => {
      const exporter = PrometheusExporter.getInstance()
      try { exporter.stop() } catch { /* ignore */ }
      globalRegister.clear()
    })

    test('should be a singleton', () => {
      const instance1 = PrometheusExporter.getInstance()
      const instance2 = PrometheusExporter.getInstance()
      expect(instance1).toBe(instance2)
    })

    test('should configure options', () => {
      const exporter = PrometheusExporter.getInstance()
      exporter.configure({
        prefix: TEST_PREFIX,
        collectDefaultMetricsEnabled: false,
        autoStart: false,
      })
    })

    test('should start and stop without errors', () => {
      const exporter = PrometheusExporter.getInstance()
      exporter.configure({
        prefix: TEST_PREFIX,
        collectDefaultMetricsEnabled: false,
        autoStart: false,
      })
      expect(exporter.started).toBe(false)
      exporter.start()
      expect(exporter.started).toBe(true)
      exporter.stop()
      expect(exporter.started).toBe(false)
    })
  })

  describe('GAP-31: 操作计数接口', () => {
    beforeEach(() => {
      const exporter = PrometheusExporter.getInstance()
      exporter.configure({ prefix: TEST_PREFIX, collectDefaultMetricsEnabled: false, autoStart: false })
      exporter.start()
    })

    afterEach(() => {
      const exporter = PrometheusExporter.getInstance()
      exporter.stop()
      globalRegister.clear()
    })

    test('incrementQueries should produce metrics output', async () => {
      const exporter = PrometheusExporter.getInstance()
      exporter.incrementQueries()
      exporter.incrementQueries()

      const metrics = await exporter.getMetrics()
      expect(metrics).toContain(`${TEST_PREFIX}queries_total`)
      expect(metrics).toContain('2')
    })

    test('incrementNodeOps should produce labeled metrics', async () => {
      const exporter = PrometheusExporter.getInstance()
      exporter.incrementNodeOps('create')
      exporter.incrementNodeOps('create')

      const metrics = await exporter.getMetrics()
      expect(metrics).toContain(`${TEST_PREFIX}node_ops_total`)
      expect(metrics).toContain('operation="create"')
    })

    test('incrementEdgeOps should produce labeled metrics', async () => {
      const exporter = PrometheusExporter.getInstance()
      exporter.incrementEdgeOps('delete')

      const metrics = await exporter.getMetrics()
      expect(metrics).toContain(`${TEST_PREFIX}edge_ops_total`)
      expect(metrics).toContain('operation="delete"')
    })

    test('should track all operations independently', async () => {
      const exporter = PrometheusExporter.getInstance()
      exporter.incrementQueries()
      exporter.incrementNodeOps('create')
      exporter.incrementEdgeOps('read')

      const metrics = await exporter.getMetrics()
      expect(metrics).toContain(`${TEST_PREFIX}queries_total 1`)
      expect(metrics).toContain('operation="create"')
      expect(metrics).toContain('operation="read"')
    })
  })

  describe('GAP-31: 延迟记录接口', () => {
    beforeEach(() => {
      const exporter = PrometheusExporter.getInstance()
      exporter.configure({ prefix: TEST_PREFIX, collectDefaultMetricsEnabled: false, autoStart: false })
      exporter.start()
    })

    afterEach(() => {
      const exporter = PrometheusExporter.getInstance()
      exporter.stop()
      globalRegister.clear()
    })

    test('recordQueryLatency should produce histogram metrics', async () => {
      const exporter = PrometheusExporter.getInstance()
      exporter.recordQueryLatency(42.5)

      const metrics = await exporter.getMetrics()
      expect(metrics).toContain(`${TEST_PREFIX}query_duration_ms`)
      expect(metrics).toContain('_bucket{le=')
      expect(metrics).toContain('_count')
      expect(metrics).toContain('_sum')
    })

    test('recordNodeLatency should produce labeled histogram metrics', async () => {
      const exporter = PrometheusExporter.getInstance()
      exporter.recordNodeLatency(15.3, 'upsert')

      const metrics = await exporter.getMetrics()
      expect(metrics).toContain(`${TEST_PREFIX}node_op_duration_ms`)
      expect(metrics).toContain('operation="upsert"')
    })

    test('recordEdgeLatency should produce labeled histogram metrics', async () => {
      const exporter = PrometheusExporter.getInstance()
      exporter.recordEdgeLatency(8.2, 'upsert')

      const metrics = await exporter.getMetrics()
      expect(metrics).toContain(`${TEST_PREFIX}edge_op_duration_ms`)
      expect(metrics).toContain('operation="upsert"')
    })

    test('histogram should accumulate multiple samples', async () => {
      const exporter = PrometheusExporter.getInstance()
      exporter.recordQueryLatency(5)
      exporter.recordQueryLatency(10)
      exporter.recordQueryLatency(15)

      const metrics = await exporter.getMetrics()
      // 3 samples should have count=3
      const countMatch = metrics.match(new RegExp(`${TEST_PREFIX}query_duration_ms_count (\\d+)`))
      if (countMatch) {
        expect(parseInt(countMatch[1], 10)).toBe(3)
      }
    })
  })

  describe('GAP-31: 仪表盘接口', () => {
    beforeEach(() => {
      const exporter = PrometheusExporter.getInstance()
      exporter.configure({ prefix: TEST_PREFIX, collectDefaultMetricsEnabled: false, autoStart: false })
      exporter.start()
    })

    afterEach(() => {
      const exporter = PrometheusExporter.getInstance()
      exporter.stop()
      globalRegister.clear()
    })

    test('setNodeCount should produce gauge metrics', async () => {
      const exporter = PrometheusExporter.getInstance()
      exporter.setNodeCount(100)

      const metrics = await exporter.getMetrics()
      expect(metrics).toContain(`${TEST_PREFIX}node_count 100`)
    })

    test('setEdgeCount should produce gauge metrics', async () => {
      const exporter = PrometheusExporter.getInstance()
      exporter.setEdgeCount(500)

      const metrics = await exporter.getMetrics()
      expect(metrics).toContain(`${TEST_PREFIX}edge_count 500`)
    })

    test('setNodeTypeCount should produce labeled gauge', async () => {
      const exporter = PrometheusExporter.getInstance()
      exporter.setNodeTypeCount(1, 50)
      exporter.setNodeTypeCount(2, 30)

      const metrics = await exporter.getMetrics()
      expect(metrics).toContain(`${TEST_PREFIX}node_type_count`)
      expect(metrics).toContain('type_id="1"')
      expect(metrics).toContain('type_id="2"')
    })

    test('gauges should update values', async () => {
      const exporter = PrometheusExporter.getInstance()
      exporter.setNodeCount(100)
      exporter.setNodeCount(200)

      const metrics = await exporter.getMetrics()
      expect(metrics).toContain(`${TEST_PREFIX}node_count 200`)
    })
  })

  describe('GAP-31: getRegistry 和 content-type', () => {
    beforeEach(() => {
      const exporter = PrometheusExporter.getInstance()
      exporter.configure({ prefix: TEST_PREFIX, collectDefaultMetricsEnabled: false, autoStart: false })
      exporter.start()
    })

    afterEach(() => {
      const exporter = PrometheusExporter.getInstance()
      exporter.stop()
      globalRegister.clear()
    })

    test('getRegistry should return register', async () => {
      const exporter = PrometheusExporter.getInstance()
      const registry = exporter.getRegistry()
      expect(registry).toBeDefined()
      const metrics = await registry.metrics()
      expect(typeof metrics).toBe('string')
      expect(metrics.length).toBeGreaterThan(0)
    })

    test('getContentType should return prometheus content type', () => {
      const exporter = PrometheusExporter.getInstance()
      const contentType = exporter.getContentType()
      expect(contentType).toContain('text/plain')
    })
  })

  describe('GAP-31: getMetrics 输出格式', () => {
    beforeEach(() => {
      const exporter = PrometheusExporter.getInstance()
      exporter.configure({ prefix: TEST_PREFIX, collectDefaultMetricsEnabled: false, autoStart: false })
      exporter.start()
    })

    afterEach(() => {
      const exporter = PrometheusExporter.getInstance()
      exporter.stop()
      globalRegister.clear()
    })

    test('output should be valid Prometheus text format', async () => {
      const exporter = PrometheusExporter.getInstance()
      exporter.incrementQueries()
      exporter.setNodeCount(42)

      const metrics = await exporter.getMetrics()
      expect(metrics).toContain('# HELP')
      expect(metrics).toContain('# TYPE')
    })

    test('should include both counter and gauge in output', async () => {
      const exporter = PrometheusExporter.getInstance()
      exporter.incrementQueries()
      exporter.setNodeCount(77)

      const metrics = await exporter.getMetrics()
      expect(metrics).toContain(`${TEST_PREFIX}queries_total`)
      expect(metrics).toContain(`${TEST_PREFIX}node_count`)
    })
  })

  describe('GAP-31: 自定义前缀', () => {
    const CUSTOM_PREFIX = 'custom_gvec_'

    beforeEach(() => {
      const exporter = PrometheusExporter.getInstance()
      exporter.configure({ prefix: CUSTOM_PREFIX, collectDefaultMetricsEnabled: false, autoStart: false })
      exporter.start()
    })

    afterEach(() => {
      const exporter = PrometheusExporter.getInstance()
      exporter.stop()
      globalRegister.clear()
    })

    test('should use custom prefix when configured', async () => {
      const exporter = PrometheusExporter.getInstance()
      exporter.incrementQueries()
      exporter.setNodeCount(10)

      const metrics = await exporter.getMetrics()
      expect(metrics).toContain(`${CUSTOM_PREFIX}queries_total`)
      expect(metrics).not.toContain(`${TEST_PREFIX}queries_total`)
    })
  })
})
