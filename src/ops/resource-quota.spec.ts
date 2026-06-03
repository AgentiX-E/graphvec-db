/**
 * resource-quota.spec.ts — ResourceQuotaManager 测试套件
 *
 * 测试覆盖：
 * 1. 默认配置
 * 2. tryAcquire 在限制内返回 true
 * 3. 超限返回 false
 * 4. 配置修改
 * 5. 内存使用报告
 * 6. 重置计数器
 * 7. dispose 清理定时器
 * 8. 大量查询时的限制行为
 */

import { describe, test, expect, afterEach, beforeEach } from 'vitest'
import { ResourceQuotaManager, ResourceQuotaConfig } from './resource-quota'

describe('ResourceQuotaManager', () => {
  let manager: ResourceQuotaManager

  afterEach(() => {
    if (manager) {
      manager.dispose()
    }
  })

  // ── 默认配置 ──────────────────────────────

  test('should apply default config when no options provided', () => {
    manager = new ResourceQuotaManager()
    const cfg = manager.getConfig()
    expect(cfg.maxMemoryMB).toBe(1024)
    expect(cfg.maxQueriesPerSec).toBe(1000)
    expect(cfg.maxConnections).toBe(100)
  })

  test('should merge partial config with defaults', () => {
    manager = new ResourceQuotaManager({ maxMemoryMB: 2048 })
    const cfg = manager.getConfig()
    expect(cfg.maxMemoryMB).toBe(2048)
    expect(cfg.maxQueriesPerSec).toBe(1000) // 默认
    expect(cfg.maxConnections).toBe(100)    // 默认
  })

  test('should override all config values', () => {
    const custom: ResourceQuotaConfig = { maxMemoryMB: 512, maxQueriesPerSec: 50, maxConnections: 10 }
    manager = new ResourceQuotaManager(custom)
    expect(manager.getConfig()).toEqual({
      maxMemoryMB: 512,
      maxQueriesPerSec: 50,
      maxConnections: 10,
    })
  })

  // ── tryAcquire ────────────────────────────

  test('tryAcquire should return true when within limit', () => {
    manager = new ResourceQuotaManager({ maxQueriesPerSec: 5 })
    for (let i = 0; i < 5; i++) {
      expect(manager.tryAcquire()).toBe(true)
    }
  })

  test('tryAcquire should return false when quota exceeded', () => {
    manager = new ResourceQuotaManager({ maxQueriesPerSec: 5 })
    for (let i = 0; i < 5; i++) {
      manager.tryAcquire()
    }
    expect(manager.tryAcquire()).toBe(false)
    expect(manager.tryAcquire()).toBe(false)
  })

  test('tryAcquire should return true after reset', () => {
    manager = new ResourceQuotaManager({ maxQueriesPerSec: 3 })
    for (let i = 0; i < 3; i++) {
      manager.tryAcquire()
    }
    expect(manager.tryAcquire()).toBe(false)

    manager.reset()
    expect(manager.tryAcquire()).toBe(true)
  })

  test('tryAcquire should return false for zero capacity', () => {
    manager = new ResourceQuotaManager({ maxQueriesPerSec: 0 })
    expect(manager.tryAcquire()).toBe(false)
  })

  test('tryAcquire should increment query count on success', () => {
    manager = new ResourceQuotaManager({ maxQueriesPerSec: 10 })
    expect(manager.getQueryCount()).toBe(0)
    manager.tryAcquire()
    expect(manager.getQueryCount()).toBe(1)
    manager.tryAcquire()
    expect(manager.getQueryCount()).toBe(2)
  })

  // ── 内存使用报告 ──────────────────────────

  test('getMemoryUsageMB should return a positive number', () => {
    manager = new ResourceQuotaManager()
    const mem = manager.getMemoryUsageMB()
    expect(typeof mem).toBe('number')
    // 内存使用最少应大于 0（进程启动后必然有内存占用）
    expect(mem).toBeGreaterThan(0)
  })

  test('getMemoryUsageMB should return an integer', () => {
    manager = new ResourceQuotaManager()
    const mem = manager.getMemoryUsageMB()
    expect(Number.isInteger(mem)).toBe(true)
  })

  test('getMemoryUsageMB should report reasonably sized heap', () => {
    manager = new ResourceQuotaManager()
    const mem = manager.getMemoryUsageMB()
    // Node 进程初始堆通常小于 1024 MB（除非极特殊环境）
    expect(mem).toBeLessThan(4096)
  })

  // ── 配置修改 ──────────────────────────────

  test('updateConfig should change maxQueriesPerSec', () => {
    manager = new ResourceQuotaManager({ maxQueriesPerSec: 100 })
    manager.updateConfig({ maxQueriesPerSec: 3 })
    expect(manager.getConfig().maxQueriesPerSec).toBe(3)
    // 新限制立即生效
    for (let i = 0; i < 3; i++) {
      expect(manager.tryAcquire()).toBe(true)
    }
    expect(manager.tryAcquire()).toBe(false)
  })

  test('updateConfig should change maxMemoryMB', () => {
    manager = new ResourceQuotaManager({ maxMemoryMB: 1024 })
    manager.updateConfig({ maxMemoryMB: 2048 })
    expect(manager.getConfig().maxMemoryMB).toBe(2048)
  })

  test('updateConfig should change maxConnections', () => {
    manager = new ResourceQuotaManager({ maxConnections: 50 })
    manager.updateConfig({ maxConnections: 200 })
    expect(manager.getConfig().maxConnections).toBe(200)
  })

  // ── dispose ───────────────────────────────

  test('dispose should stop auto-reset without throwing', () => {
    manager = new ResourceQuotaManager()
    expect(() => manager.dispose()).not.toThrow()
  })

  test('multiple dispose calls should be safe', () => {
    manager = new ResourceQuotaManager()
    manager.dispose()
    expect(() => manager.dispose()).not.toThrow()
  })
})
