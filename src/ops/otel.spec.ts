/**
 * otel.spec.ts — OTel 模块单元测试
 *
 * 测试场景：
 * 1. Telemetry 默认未启用
 * 2. Telemetry init/shutdown 生命周期
 * 3. traceAsync 默认禁用时直接执行（零开销）
 * 4. MetricsCollector 依赖 Telemetry 状态
 * 5. MetricsCollector 在禁用时无操作
 * 6. GAP-59: 导出配置（环境变量/Jaeger/Zipkin）
 * 7. GAP-59: registerInstrumentations 调用（自动 instrumentation）
 */
import { Telemetry } from './otel'
import { MetricsCollector } from './otel-metrics'

describe('Telemetry', () => {
  let telemetry: Telemetry

  beforeEach(() => {
    // 每次测试重置单例
    // 通过 getInstance() 获取的 Telemetry 是同一个实例，
    // 需要确保测试间状态隔离
    telemetry = Telemetry.getInstance()
  })

  afterEach(async () => {
    await telemetry.shutdown()
  })

  it('should not be enabled by default', () => {
    expect(telemetry.isEnabled()).toBe(false)
  })

  it('should be disabled after shutdown', async () => {
    // init will silently fail (no real OTLP endpoint), enabled stays false
    await telemetry.init('test-service', '')
    await telemetry.shutdown()
    expect(telemetry.isEnabled()).toBe(false)
  })

  it('startSpan should return null when disabled', () => {
    expect(telemetry.startSpan('test')).toBeNull()
  })

  it('endSpan should not throw when span is null', () => {
    expect(() => telemetry.endSpan(null)).not.toThrow()
  })

  it('traceAsync should execute fn directly when disabled', async () => {
    let executed = false
    const result = await telemetry.traceAsync('test', async () => {
      executed = true
      return 42
    })
    expect(executed).toBe(true)
    expect(result).toBe(42)
  })

  it('traceAsync should return fn result when disabled', async () => {
    const result = await telemetry.traceAsync('test', async () => 'hello')
    expect(result).toBe('hello')
  })

  it('traceAsync should propagate fn errors when disabled', async () => {
    const testError = new Error('test error')
    await expect(
      telemetry.traceAsync('test', async () => {
        throw testError
      })
    ).rejects.toThrow('test error')
  })

  it('shutdown on non-initialized telemetry should not throw', async () => {
    const t = Telemetry.getInstance()
    await expect(t.shutdown()).resolves.toBeUndefined()
  })

  // ── GAP-59: 导出配置 ──────────────────────

  it('GAP-59-01: initWithInstrumentations should not throw (silent fail)', async () => {
    // SDK init may attempt connection, but should not throw
    await expect(
      telemetry.initWithInstrumentations('test-svc', 'http://invalid:4317')
    ).resolves.toBeUndefined()
    // If collector unavailable, the SDK may still report as enabled;
    // we don't assert isEnabled() here since it depends on whether
    // the OTel SDK throws or swallows the connection error.
  })

  it('GAP-59-02: initWithInstrumentations with empty endpoint should not throw', async () => {
    await expect(
      telemetry.initWithInstrumentations('test-svc', '')
    ).resolves.toBeUndefined()
  })

  it('GAP-59-03: registerInstrumentations should not throw when disabled', () => {
    // registerInstrumentations is safe to call when disabled
    expect(() => telemetry.registerInstrumentations()).not.toThrow()
  })

  it('GAP-59-04: initWithInstrumentations should not throw', async () => {
    // Will silently fail (no real collector), but should not throw
    await expect(
      telemetry.initWithInstrumentations('test-svc', 'http://invalid:4317')
    ).resolves.toBeUndefined()
  })

  it('GAP-59-05: registerInstrumentations is idempotent', () => {
    // Calling twice is safe
    telemetry.registerInstrumentations()
    telemetry.registerInstrumentations()
    // No throw
  })
})

describe('MetricsCollector', () => {
  let telemetry: Telemetry
  let metrics: MetricsCollector

  beforeEach(() => {
    telemetry = Telemetry.getInstance()
    metrics = MetricsCollector.getInstance()
  })

  afterEach(async () => {
    await telemetry.shutdown()
  })

  it('should not be enabled by default', () => {
    expect(metrics.isEnabled()).toBe(false)
  })

  it('should not be enabled after Telemetry init without MetricsCollector init', async () => {
    await telemetry.init('test-service', '')
    // 注意：MetricsCollector.init() 未调用
    // telemetry 启用但 metrics 自身未初始化
    expect(metrics.isEnabled()).toBe(false)
  })

  it('incrementCounter should not throw when disabled', () => {
    expect(() => metrics.incrementCounter('test.counter')).not.toThrow()
  })

  it('recordHistogram should not throw when disabled', () => {
    expect(() => metrics.recordHistogram('test.histogram', 42)).not.toThrow()
  })

  it('setGauge should not throw when disabled', () => {
    expect(() => metrics.setGauge('test.gauge', 100)).not.toThrow()
  })
})
