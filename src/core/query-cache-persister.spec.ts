/**
 * query-cache-persister.spec.ts — QueryCachePersister 单元测试
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { QueryResultCache, makeQueryCacheKey } from './query-cache'
import { QueryCachePersister } from './query-cache-persister'
import * as fs from 'node:fs'
import * as path from 'node:path'

const TEST_WAL = './test-data/cache-persist-test.wal'

describe('QueryCachePersister', () => {
  let cache: QueryResultCache
  let persister: QueryCachePersister

  beforeEach(() => {
    // 确保测试目录存在
    const dir = path.dirname(TEST_WAL)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    // 清理之前的测试 WAL
    try { fs.unlinkSync(TEST_WAL) } catch { /* ignore */ }

    cache = new QueryResultCache({ maxSize: 100, ttlSec: 60 })
  })

  afterEach(async () => {
    if (persister) {
      await persister.stop()
    }
    try { fs.unlinkSync(TEST_WAL) } catch { /* ignore */ }
  })

  describe('constructor and start', () => {
    test('should create with default config', () => {
      persister = new QueryCachePersister(cache)
      expect(persister).toBeDefined()
      expect(persister.started).toBe(false)
    })

    test('should create with custom config', () => {
      persister = new QueryCachePersister(cache, {
        persistPath: TEST_WAL,
        persistInterval: 10000,
        maxRecoverEntries: 500,
      })
      expect(persister).toBeDefined()
    })

    test('should start and create WAL file', async () => {
      persister = new QueryCachePersister(cache, {
        persistPath: TEST_WAL,
        persistInterval: 0, // 禁用自动持久化
      })
      await persister.start()
      expect(persister.started).toBe(true)
      // 目录和文件流应已创建
      expect(fs.existsSync(path.dirname(TEST_WAL))).toBe(true)
    })

    test('should be idempotent on start', async () => {
      persister = new QueryCachePersister(cache, {
        persistPath: TEST_WAL,
        persistInterval: 0,
      })
      await persister.start()
      await persister.start() // 第二次 start 应无副作用
      expect(persister.started).toBe(true)
    })
  })

  describe('enqueue and flush', () => {
    test('should queue entries and not flush without trigger', async () => {
      persister = new QueryCachePersister(cache, {
        persistPath: TEST_WAL,
        persistInterval: 0,
      })
      await persister.start()

      const key = makeQueryCacheKey('MATCH (n:Person) RETURN n')
      const entry = {
        results: [{ id: 1, name: 'Alice' }],
        query: 'MATCH (n:Person) RETURN n',
        cachedAt: Date.now(),
        tags: ['Person'],
      }

      persister.enqueue(key, entry)
      expect(persister.pendingCount).toBe(1)
    })

    test('should flush entries to WAL file', async () => {
      persister = new QueryCachePersister(cache, {
        persistPath: TEST_WAL,
        persistInterval: 0,
      })
      await persister.start()

      const key = makeQueryCacheKey('Q1')
      const entry = {
        results: [{ id: 1, name: 'Alice' }],
        query: 'Q1',
        cachedAt: Date.now(),
        tags: ['Person'],
      }

      persister.enqueue(key, entry)
      await persister.flushPending()

      expect(persister.pendingCount).toBe(0)
      const content = fs.readFileSync(TEST_WAL, 'utf-8')
      expect(content).toContain('Q1')
      expect(content).toContain('Alice')
    })

    test('should flush multiple entries', async () => {
      persister = new QueryCachePersister(cache, {
        persistPath: TEST_WAL,
        persistInterval: 0,
      })
      await persister.start()

      persister.enqueue(makeQueryCacheKey('Q1'), {
        results: ['r1'], query: 'Q1', cachedAt: Date.now(), tags: ['A'],
      })
      persister.enqueue(makeQueryCacheKey('Q2'), {
        results: ['r2'], query: 'Q2', cachedAt: Date.now(), tags: ['B'],
      })
      await persister.flushPending()

      const content = fs.readFileSync(TEST_WAL, 'utf-8')
      const lines = content.split('\n').filter(Boolean)
      expect(lines.length).toBe(2)
    })

    test('should flush on stop', async () => {
      persister = new QueryCachePersister(cache, {
        persistPath: TEST_WAL,
        persistInterval: 0,
      })
      await persister.start()

      persister.enqueue(makeQueryCacheKey('Q-stop'), {
        results: ['stop'], query: 'Q-stop', cachedAt: Date.now(), tags: [],
      })

      // stop 时会自动 flush
      await persister.stop()
      const content = fs.readFileSync(TEST_WAL, 'utf-8')
      expect(content).toContain('Q-stop')
    })
  })

  describe('recover from WAL', () => {
    test('should recover persisted entries', async () => {
      // 先写入缓存条目
      const p1 = new QueryCachePersister(cache, {
        persistPath: TEST_WAL,
        persistInterval: 0,
      })
      await p1.start()
      const key = makeQueryCacheKey('recover-test')
      p1.enqueue(key, {
        results: [{ id: 99, name: 'Recovered' }],
        query: 'recover-test',
        cachedAt: Date.now(),
        tags: ['Test'],
      })
      await p1.flushPending()
      await p1.stop()

      // 新建缓存和 persister，从文件恢复
      const cache2 = new QueryResultCache({ maxSize: 100, ttlSec: 60 })
      const p2 = new QueryCachePersister(cache2, {
        persistPath: TEST_WAL,
        persistInterval: 0,
      })
      const recovered = await p2.recover()

      expect(recovered).toBeGreaterThanOrEqual(1)

      // 验证缓存内容
      const entry = cache2.get(key)
      expect(entry).toBeDefined()
      expect(entry!.results).toEqual([{ id: 99, name: 'Recovered' }])
      expect(entry!.query).toBe('recover-test')

      await p2.stop()
    })

    test('should skip expired entries during recovery', async () => {
      // 写入一个过期条目和一个有效条目
      const p1 = new QueryCachePersister(cache, {
        persistPath: TEST_WAL,
        persistInterval: 0,
      })
      await p1.start()

      const expiredKey = makeQueryCacheKey('expired')
      const validKey = makeQueryCacheKey('valid')

      // 过期条目（1 小时前）
      p1.enqueue(expiredKey, {
        results: ['old'], query: 'expired', cachedAt: Date.now() - 3600000, tags: [],
      })
      // 有效条目（现在）
      p1.enqueue(validKey, {
        results: ['new'], query: 'valid', cachedAt: Date.now(), tags: [],
      })
      await p1.flushPending()
      await p1.stop()

      // 恢复
      const cache2 = new QueryResultCache({ maxSize: 100, ttlSec: 60 })
      const p2 = new QueryCachePersister(cache2, {
        persistPath: TEST_WAL,
        persistInterval: 0,
      })
      const recovered = await p2.recover()

      // 应只恢复有效条目
      expect(recovered).toBeGreaterThanOrEqual(1)
      expect(cache2.get(expiredKey)).toBeUndefined()
      expect(cache2.get(validKey)).toBeDefined()

      await p2.stop()
    })

    test('should handle non-existent WAL file', async () => {
      // 删除测试 WAL（已在 beforeEach 中删除）
      try { fs.unlinkSync(TEST_WAL) } catch { /* ignore */ }

      persister = new QueryCachePersister(cache, {
        persistPath: TEST_WAL,
        persistInterval: 0,
      })
      const recovered = await persister.recover()
      expect(recovered).toBe(0)
    })

    test('should recover at most maxEntries', async () => {
      // 写入多条记录
      const p1 = new QueryCachePersister(cache, {
        persistPath: TEST_WAL,
        persistInterval: 0,
      })
      await p1.start()
      for (let i = 0; i < 10; i++) {
        p1.enqueue(makeQueryCacheKey(`Q${i}`), {
          results: [`r${i}`], query: `Q${i}`, cachedAt: Date.now(), tags: [],
        })
      }
      await p1.flushPending()
      await p1.stop()

      // 只恢复最近 5 条
      const cache2 = new QueryResultCache({ maxSize: 100, ttlSec: 60 })
      const p2 = new QueryCachePersister(cache2, {
        persistPath: TEST_WAL,
        persistInterval: 0,
      })
      const recovered = await p2.recover(5)
      expect(recovered).toBe(5)

      // Q0-Q4 应未被恢复（超过 maxRecoverEntries，取末尾）
      expect(cache2.get(makeQueryCacheKey('Q0'))).toBeUndefined()
      expect(cache2.get(makeQueryCacheKey('Q9'))).toBeDefined()

      await p2.stop()
    })

    test('should handle malformed WAL lines gracefully', async () => {
      // 写入有效行 + 无效行
      fs.writeFileSync(TEST_WAL, JSON.stringify({
        k: makeQueryCacheKey('valid'), v: {
          results: ['ok'], query: 'valid', cachedAt: Date.now(), tags: [],
        },
      }) + '\n' + 'not-json\n' + JSON.stringify({
        k: makeQueryCacheKey('valid2'), v: {
          results: ['ok2'], query: 'valid2', cachedAt: Date.now(), tags: [],
        },
      }) + '\n')

      persister = new QueryCachePersister(cache, {
        persistPath: TEST_WAL,
        persistInterval: 0,
      })
      const recovered = await persister.recover()
      expect(recovered).toBe(2)
    })
  })

  describe('graceful degradation', () => {
    test('should not crash on invalid persist path', async () => {
      persister = new QueryCachePersister(cache, {
        persistPath: '/nonexistent/deep/dir/cache.wal',
        persistInterval: 0,
      })
      // 即使写入流初始化失败也不应抛出
      await expect(persister.start()).resolves.not.toThrow()
    })

    test('should not crash on enqueue after stop', async () => {
      persister = new QueryCachePersister(cache, {
        persistPath: TEST_WAL,
        persistInterval: 0,
      })
      await persister.start()
      await persister.stop()

      // stop 后 enqueue 应无副作用
      expect(() => {
        persister.enqueue(makeQueryCacheKey('after-stop'), {
          results: ['x'], query: 'after-stop', cachedAt: Date.now(), tags: [],
        })
      }).not.toThrow()
    })
  })

  describe('integration with periodic persist', () => {
    test('should auto-flush on interval', async () => {
      persister = new QueryCachePersister(cache, {
        persistPath: TEST_WAL,
        persistInterval: 100, // 每 100ms 自动 flush
      })
      await persister.start()

      persister.enqueue(makeQueryCacheKey('auto-flush'), {
        results: ['auto'], query: 'auto-flush', cachedAt: Date.now(), tags: [],
      })

      // 等待自动 flush
      await new Promise(r => setTimeout(r, 200))

      const content = fs.readFileSync(TEST_WAL, 'utf-8')
      expect(content).toContain('auto-flush')

      await persister.stop()
    })
  })
})
