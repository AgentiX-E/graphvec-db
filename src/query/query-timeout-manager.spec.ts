/**
 * query-timeout-manager.spec.ts — QueryTimeoutManager 测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { QueryTimeoutManager, QueryTimeoutError } from './query-timeout-manager'

describe('QueryTimeoutManager', () => {
  let manager: QueryTimeoutManager

  beforeEach(() => {
    manager = new QueryTimeoutManager()
  })

  describe('constructor and config', () => {
    it('should use default config', () => {
      const cfg = manager.getConfig()
      expect(cfg.defaultTimeoutMs).toBe(30000)
      expect(cfg.perTypeTimeoutMs).toEqual({})
    })

    it('should accept custom config', () => {
      const m = new QueryTimeoutManager({
        defaultTimeoutMs: 15000,
        perTypeTimeoutMs: { 'graph-query': 5000 },
      })
      const cfg = m.getConfig()
      expect(cfg.defaultTimeoutMs).toBe(15000)
      expect(cfg.perTypeTimeoutMs['graph-query']).toBe(5000)
    })

    it('should allow runtime config update', () => {
      manager.setConfig({ defaultTimeoutMs: 10000 })
      expect(manager.getConfig().defaultTimeoutMs).toBe(10000)
    })
  })

  describe('runWithTimeout', () => {
    it('should resolve fast async functions', async () => {
      const result = await manager.runWithTimeout(() => Promise.resolve(42))
      expect(result).toBe(42)
    })

    it('should reject with QueryTimeoutError when promise exceeds timeout', async () => {
      const m = new QueryTimeoutManager({ defaultTimeoutMs: 10 })
      await expect(
        m.runWithTimeout(() => new Promise(resolve => setTimeout(resolve, 5000))),
      ).rejects.toThrow(QueryTimeoutError)
    })

    it('should use per-type timeout when specified', async () => {
      const m = new QueryTimeoutManager({
        defaultTimeoutMs: 30000,
        perTypeTimeoutMs: { 'slow-query': 10 },
      })
      await expect(
        m.runWithTimeout(
          () => new Promise(resolve => setTimeout(resolve, 5000)),
          { queryType: 'slow-query' },
        ),
      ).rejects.toThrow(QueryTimeoutError)
    })

    it('should use default timeout for unknown type', async () => {
      const m = new QueryTimeoutManager({
        defaultTimeoutMs: 10,
        perTypeTimeoutMs: { 'fast-query': 10000 },
      })
      // 'slow-query' not in perTypeTimeoutMs, so falls back to default (10ms)
      await expect(
        m.runWithTimeout(
          () => new Promise(resolve => setTimeout(resolve, 5000)),
          { queryType: 'slow-query' },
        ),
      ).rejects.toThrow(QueryTimeoutError)
    })

    it('should propagate original error', async () => {
      await expect(
        manager.runWithTimeout(() => Promise.reject(new Error('db error'))),
      ).rejects.toThrow('db error')
    })

    it('should respect external AbortSignal', async () => {
      const controller = new AbortController()
      const promise = manager.runWithTimeout(
        () => new Promise(resolve => setTimeout(resolve, 5000)),
        { abortSignal: controller.signal },
      )
      controller.abort(new Error('cancelled'))
      await expect(promise).rejects.toThrow(QueryTimeoutError)
    })
  })

  describe('wrapPromise', () => {
    it('should timeout a slow promise', async () => {
      const m = new QueryTimeoutManager({ defaultTimeoutMs: 10 })
      await expect(
        m.wrapPromise(new Promise(resolve => setTimeout(resolve, 5000))),
      ).rejects.toThrow(QueryTimeoutError)
    })

    it('should resolve a fast promise', async () => {
      const result = await manager.wrapPromise(Promise.resolve('ok'))
      expect(result).toBe('ok')
    })
  })

  describe('createRequestTimeout', () => {
    it('should create controller and cancel function', () => {
      const { controller, cancel } = manager.createRequestTimeout(1000)
      expect(controller).toBeInstanceOf(AbortController)
      expect(typeof cancel).toBe('function')
      cancel()
    })

    it('should abort after timeout', async () => {
      const { controller } = manager.createRequestTimeout(5)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(controller.signal.aborted).toBe(true)
    })

    it('should not abort before timeout', async () => {
      const { controller } = manager.createRequestTimeout(5000)
      expect(controller.signal.aborted).toBe(false)
      controller.abort() // cleanup
    })

    it('should link to parent signal', async () => {
      const parent = new AbortController()
      const { controller } = manager.createRequestTimeout(5000, parent.signal)
      expect(controller.signal.aborted).toBe(false)
      parent.abort()
      expect(controller.signal.aborted).toBe(true)
    })

    it('cancel should cleanup timer', async () => {
      const { controller, cancel } = manager.createRequestTimeout(10)
      cancel()
      // Give time for the timer to fire if not cancelled
      await new Promise(resolve => setTimeout(resolve, 50))
      // Controller should be aborted by cancel
      expect(controller.signal.aborted).toBe(true)
    })
  })

  describe('stats', () => {
    it('should track total runs', async () => {
      await manager.runWithTimeout(() => Promise.resolve(1))
      await manager.runWithTimeout(() => Promise.resolve(2))
      expect(manager.getStats().totalRuns).toBe(2)
    })

    it('should track timeout count', async () => {
      const m = new QueryTimeoutManager({ defaultTimeoutMs: 5 })
      // 多次超时
      for (let i = 0; i < 3; i++) {
        await m.runWithTimeout(
          () => new Promise(resolve => setTimeout(resolve, 1000)),
        ).catch(() => {})
      }
      expect(manager.getStats().timeoutCount).toBe(0)
      expect(m.getStats().timeoutCount).toBe(3)
      expect(m.getStats().totalRuns).toBe(3)
    })

    it('should track cancel count via AbortSignal', async () => {
      const controller = new AbortController()
      const promise = manager.runWithTimeout(
        () => new Promise(resolve => setTimeout(resolve, 5000)),
        { abortSignal: controller.signal },
      )
      controller.abort()
      await promise.catch(() => {})
      expect(manager.getStats().cancelCount).toBe(1)
    })

    it('should reset stats', async () => {
      await manager.runWithTimeout(() => Promise.resolve(1))
      expect(manager.getStats().totalRuns).toBe(1)
      manager.resetStats()
      expect(manager.getStats().totalRuns).toBe(0)
    })
  })
})
