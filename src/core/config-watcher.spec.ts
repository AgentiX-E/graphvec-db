/**
 * config-watcher.spec.ts — ConfigWatcher 测试
 *
 * 由于 vitest.config.ts 中将 chokidar 别名指向了
 * src/security/__mocks__/chokidar.ts（MockFSWatcher），
 * 测试中的 chokidar 操作会走 mock 路径。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ConfigWatcher, ConfigChangeEvent } from './config-watcher'
import * as fs from 'fs'
import * as path from 'path'
import { tmpdir } from 'os'

const TEST_DIR = path.join(tmpdir(), `config-watcher-test-${Date.now()}`)
const TEST_CONFIG_PATH = path.join(TEST_DIR, 'config.json')

describe('ConfigWatcher', () => {
  beforeEach(() => {
    // 清理并创建测试目录
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true })
    }
    fs.mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  describe('constructor and getConfig', () => {
    it('should store initial config', () => {
      const watcher = new ConfigWatcher(TEST_CONFIG_PATH, { key1: 'val1', num: 42 })
      const cfg = watcher.getConfig()
      expect(cfg.key1).toBe('val1')
      expect(cfg.num).toBe(42)
    })

    it('should return a frozen copy', () => {
      const watcher = new ConfigWatcher(TEST_CONFIG_PATH, { a: 1 })
      const cfg = watcher.getConfig() as Record<string, unknown>
      expect(Object.isFrozen(cfg)).toBe(true)
    })
  })

  describe('setConfig', () => {
    it('should update config values', () => {
      const watcher = new ConfigWatcher(TEST_CONFIG_PATH, { a: 1, b: 2 })
      watcher.setConfig({ a: 10 })
      expect(watcher.getConfig().a).toBe(10)
      expect(watcher.getConfig().b).toBe(2) // unchanged
    })
  })

  describe('on and onAny event handlers', () => {
    it('should fire onAny when setConfig changes a value', () => {
      const watcher = new ConfigWatcher(TEST_CONFIG_PATH, { a: 1, b: 2 })
      const handler = vi.fn()
      watcher.onAny(handler)

      watcher.setConfig({ a: 10 })

      expect(handler).toHaveBeenCalledTimes(1)
      const event = handler.mock.calls[0][0] as ConfigChangeEvent
      expect(event.key).toBe('a')
      expect(event.previousValue).toBe(1)
      expect(event.newValue).toBe(10)
    })

    it('should fire specific on handler when setConfig changes its key', () => {
      const watcher = new ConfigWatcher(TEST_CONFIG_PATH, { a: 1, b: 2 })
      const handlerA = vi.fn()
      const handlerB = vi.fn()
      watcher.on('a', handlerA)
      watcher.on('b', handlerB)

      watcher.setConfig({ a: 99 })

      expect(handlerA).toHaveBeenCalledTimes(1)
      expect(handlerB).not.toHaveBeenCalled()
    })

    it('should not fire handler when value is unchanged', () => {
      const watcher = new ConfigWatcher(TEST_CONFIG_PATH, { a: 1 })
      const handler = vi.fn()
      watcher.on('a', handler)

      watcher.setConfig({ a: 1 }) // same value

      expect(handler).not.toHaveBeenCalled()
    })

    it('should handle multiple handlers for the same key', () => {
      const watcher = new ConfigWatcher(TEST_CONFIG_PATH, { x: 0 })
      const h1 = vi.fn()
      const h2 = vi.fn()
      watcher.on('x', h1)
      watcher.on('x', h2)

      watcher.setConfig({ x: 100 })

      expect(h1).toHaveBeenCalledTimes(1)
      expect(h2).toHaveBeenCalledTimes(1)
    })
  })

  describe('reload from file', () => {
    it('should reload config from file and fire handlers', async () => {
      // 初始写入
      fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ a: 1, b: 2 }), 'utf-8')

      const watcher = new ConfigWatcher(TEST_CONFIG_PATH, { a: 1, b: 2 })
      const handler = vi.fn()
      watcher.on('b', handler)

      // 修改文件
      fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ a: 1, b: 99 }), 'utf-8')

      await watcher.reload()

      expect(watcher.getConfig().b).toBe(99)
      expect(handler).toHaveBeenCalledTimes(1)
      const event = handler.mock.calls[0][0] as ConfigChangeEvent
      expect(event.key).toBe('b')
      expect(event.previousValue).toBe(2)
      expect(event.newValue).toBe(99)
    })

    it('should return null for non-existent config file', async () => {
      const watcher = new ConfigWatcher('/nonexistent/config.json', { a: 1 })
      // 不应该抛出异常
      await expect(watcher.reload()).resolves.toBeUndefined()
      expect(watcher.getConfig().a).toBe(1)
    })

    it('should survive invalid JSON in config file', async () => {
      fs.writeFileSync(TEST_CONFIG_PATH, 'invalid json{{{', 'utf-8')
      const watcher = new ConfigWatcher(TEST_CONFIG_PATH, { a: 1 })

      await expect(watcher.reload()).resolves.toBeUndefined()
      // 原始配置保持不变
      expect(watcher.getConfig().a).toBe(1)
    })
  })

  describe('start and stop watching', () => {
    it('should start without throwing', () => {
      const watcher = new ConfigWatcher(TEST_CONFIG_PATH, { a: 1 })
      expect(() => watcher.start()).not.toThrow()
      // 即使 chokidar 不可用（在测试中走 mock），也应正常运行
    })

    it('should not start twice', () => {
      const watcher = new ConfigWatcher(TEST_CONFIG_PATH, { a: 1 })
      watcher.start()
      // 第二次 start 不应报错
      expect(() => watcher.start()).not.toThrow()
    })

    it('should stop without throwing', async () => {
      const watcher = new ConfigWatcher(TEST_CONFIG_PATH, { a: 1 })
      watcher.start()
      await expect(watcher.stop()).resolves.toBeUndefined()
    })

    it('should report isWatching correctly', () => {
      const watcher = new ConfigWatcher(TEST_CONFIG_PATH, { a: 1 })
      expect(watcher.isWatching).toBe(false)
      watcher.start()
      expect(watcher.isWatching).toBe(true)
      // stop is async — isWatching goes false immediately
    })
  })

  describe('off handler removal', () => {
    it('should remove a specific handler', () => {
      const watcher = new ConfigWatcher(TEST_CONFIG_PATH, { a: 1 })
      const handler = vi.fn()
      watcher.on('a', handler)
      watcher.off('a', handler)

      watcher.setConfig({ a: 99 })

      expect(handler).not.toHaveBeenCalled()
    })

    it('should not throw when removing non-existent handler', () => {
      const watcher = new ConfigWatcher(TEST_CONFIG_PATH, { a: 1 })
      const handler = vi.fn()
      expect(() => watcher.off('a', handler)).not.toThrow()
    })
  })

  describe('async handlers', () => {
    it('should not reject the caller when async handler throws', async () => {
      const watcher = new ConfigWatcher(TEST_CONFIG_PATH, { a: 1 })
      const handler = vi.fn().mockRejectedValue(new Error('handler error'))

      watcher.on('a', handler)

      // setConfig 不应该抛异常
      expect(() => watcher.setConfig({ a: 99 })).not.toThrow()

      // 给微任务一个机会执行
      await new Promise(resolve => setImmediate(resolve))
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('should not reject the caller when sync handler throws', () => {
      const watcher = new ConfigWatcher(TEST_CONFIG_PATH, { a: 1 })
      const handler = vi.fn(() => { throw new Error('sync error') })

      watcher.on('a', handler)

      // setConfig 不应该抛异常
      expect(() => watcher.setConfig({ a: 99 })).not.toThrow()
      expect(handler).toHaveBeenCalledTimes(1)
    })
  })
})
