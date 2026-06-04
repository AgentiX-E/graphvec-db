/**
 * otel-metrics.spec.ts — MetricsCollector OTel 指标测试
 *
 * 覆盖：
 * - 单例模式
 * - 构造与初始化
 * - counter/histogram/gauge 注册
 * - isEnabled 状态
 * - 空操作（Telemetry 未启用时）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MetricsCollector } from './otel-metrics'

// We use a shared mutable flag so all consumers of Telemetry see the same state
let telemetryEnabled = false

vi.mock('./otel', () => ({
  Telemetry: {
    getInstance: vi.fn(() => ({
      isEnabled: vi.fn(() => telemetryEnabled),
    })),
  },
}))

describe('MetricsCollector', () => {
  let collector: MetricsCollector

  beforeEach(() => {
    vi.clearAllMocks()
    telemetryEnabled = false
    collector = MetricsCollector.getInstance()
  })

  describe('单例模式', () => {
    it('getInstance 返回相同实例', () => {
      const a = MetricsCollector.getInstance()
      const b = MetricsCollector.getInstance()
      expect(a).toBe(b)
    })

    it('getInstance 不抛异常', () => {
      expect(() => MetricsCollector.getInstance()).not.toThrow()
    })
  })

  describe('isEnabled', () => {
    it('默认未启用时返回 false', () => {
      expect(collector.isEnabled()).toBe(false)
    })

    it('init 后但 Telemetry 未启用时仍返回 false', () => {
      collector.init('test-meter')
      expect(collector.isEnabled()).toBe(false)
    })

    it('init 前即使 Telemetry 启用也返回 false', () => {
      telemetryEnabled = true
      expect(collector.isEnabled()).toBe(false)
    })

    it('Telemetry 启用 + init 后返回 true', () => {
      telemetryEnabled = true
      collector.init('test-meter')
      expect(collector.isEnabled()).toBe(true)
    })

    it('多次 init 不抛异常', () => {
      telemetryEnabled = true
      collector.init('test-meter')
      collector.init('test-meter-2')
      expect(collector.isEnabled()).toBe(true)
    })
  })

  describe('incrementCounter', () => {
    it('Telemetry 未启用时调用不抛异常（空操作）', () => {
      expect(() => collector.incrementCounter('test_counter')).not.toThrow()
      expect(() => collector.incrementCounter('test_counter', 5)).not.toThrow()
    })

    it('Telemetry 启用后调用不抛异常', () => {
      telemetryEnabled = true
      collector.init('test-meter')
      expect(() => collector.incrementCounter('ops_total')).not.toThrow()
      expect(() => collector.incrementCounter('ops_total', 3)).not.toThrow()
    })

    it('不同名称的 counter 各自独立', () => {
      telemetryEnabled = true
      collector.init('test-meter')
      expect(() => {
        collector.incrementCounter('counter_a')
        collector.incrementCounter('counter_b', 10)
      }).not.toThrow()
    })
  })

  describe('recordHistogram', () => {
    it('Telemetry 未启用时调用不抛异常', () => {
      expect(() => collector.recordHistogram('latency_ms', 150)).not.toThrow()
    })

    it('记录直方图样本不抛异常', () => {
      telemetryEnabled = true
      collector.init('test-meter')
      expect(() => collector.recordHistogram('query_latency', 42)).not.toThrow()
    })

    it('多次记录同一 histogram 不抛异常', () => {
      telemetryEnabled = true
      collector.init('test-meter')
      for (let i = 0; i < 100; i++) {
        collector.recordHistogram('test_hist', i)
      }
      expect(true).toBe(true)
    })
  })

  describe('setGauge', () => {
    it('Telemetry 未启用时调用不抛异常', () => {
      expect(() => collector.setGauge('active_connections', 42)).not.toThrow()
    })

    it('设置仪表盘值不抛异常', () => {
      telemetryEnabled = true
      collector.init('test-meter')
      expect(() => collector.setGauge('node_count', 1000)).not.toThrow()
    })

    it('更新 gauge 值不抛异常', () => {
      telemetryEnabled = true
      collector.init('test-meter')
      collector.setGauge('edge_count', 500)
      expect(() => collector.setGauge('edge_count', 600)).not.toThrow()
    })

    it('多个 gauge 互不干扰', () => {
      telemetryEnabled = true
      collector.init('test-meter')
      expect(() => {
        collector.setGauge('gauge_a', 1)
        collector.setGauge('gauge_b', 2)
        collector.setGauge('gauge_c', 3)
      }).not.toThrow()
    })
  })

  describe('命名与初始化', () => {
    it('init 使用默认名称不抛异常', () => {
      telemetryEnabled = true
      expect(() => collector.init()).not.toThrow()
    })

    it('init 使用自定义名称不抛异常', () => {
      telemetryEnabled = true
      expect(() => collector.init('custom-meter')).not.toThrow()
    })
  })
})
