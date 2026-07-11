/**
 * query-cache.spec.ts — QueryResultCache 单元测试
 */

import { describe, test, expect, beforeEach } from 'vitest'
import { QueryResultCache, makeQueryCacheKey } from './query-cache'

describe('QueryResultCache', () => {
  let cache: QueryResultCache

  beforeEach(() => {
    cache = new QueryResultCache({ maxSize: 100, ttlSec: 60 })
  })

  describe('基本的 get/set 操作', () => {
    test('set 后可以 get 到相同的结果', () => {
      const key = makeQueryCacheKey('MATCH (n:Person) RETURN n')
      const results = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]
      cache.set(key, results, { query: 'MATCH (n:Person) RETURN n', tags: ['Person'] })
      const entry = cache.get(key)
      expect(entry).toBeDefined()
      expect(entry!.results).toEqual(results)
      expect(entry!.query).toBe('MATCH (n:Person) RETURN n')
      expect(entry!.tags).toEqual(['Person'])
    })

    test('不存在的键返回 undefined', () => {
      const result = cache.get('nonexistent')
      expect(result).toBeUndefined()
    })

    test('覆盖已有的键', () => {
      const key = makeQueryCacheKey('MATCH (n) RETURN n')
      cache.set(key, [{ id: 1 }], { query: 'MATCH (n) RETURN n' })
      cache.set(key, [{ id: 2 }], { query: 'MATCH (n) RETURN n', tags: ['Node'] })
      const entry = cache.get(key)
      expect(entry!.results).toEqual([{ id: 2 }])
    })
  })

  describe('统计Info', () => {
    test('hits 和 misses 正确计数', () => {
      const key = makeQueryCacheKey('MATCH (n) RETURN n')
      cache.get(key) // miss
      cache.get('other') // miss
      expect(cache.stats.misses).toBe(2)
      expect(cache.stats.hits).toBe(0)
      expect(cache.stats.entries).toBe(0)

      cache.set(key, [{ id: 1 }], { query: 'MATCH (n) RETURN n' })
      cache.get(key) // hit
      cache.get(key) // hit
      expect(cache.stats.hits).toBe(2)
      expect(cache.stats.misses).toBe(2)
      expect(cache.stats.entries).toBe(1)
    })

    test('hitRate 计算正确', () => {
      const key = makeQueryCacheKey('Q')
      expect(cache.stats.hitRate).toBe(0)

      cache.get(key) // miss
      expect(cache.stats.hitRate).toBe(0)

      cache.set(key, ['result'], { query: 'Q' })
      cache.get(key) // hit
      expect(cache.stats.hitRate).toBe(0.5)
    })

    test('resetStats 重置计数器', () => {
      cache.get('x') // miss
      cache.resetStats()
      expect(cache.stats.hits).toBe(0)
      expect(cache.stats.misses).toBe(0)
      expect(cache.stats.entries).toBe(0)
    })
  })

  describe('失效策略', () => {
    test('invalidateByLabel 清除关联的缓存项', () => {
      const k1 = makeQueryCacheKey('Q1')
      const k2 = makeQueryCacheKey('Q2')
      cache.set(k1, ['r1'], { query: 'Q1', tags: ['Person'] })
      cache.set(k2, ['r2'], { query: 'Q2', tags: ['Company'] })

      cache.invalidateByLabel('Person')
      expect(cache.get(k1)).toBeUndefined()
      expect(cache.get(k2)).toBeDefined()
    })

    test('invalidateByNode 清除包含Node ID 标签的缓存', () => {
      const k = makeQueryCacheKey('Q')
      cache.set(k, ['r'], { query: 'Q', tags: ['42'] })
      cache.invalidateByNode(42)
      expect(cache.get(k)).toBeUndefined()
    })

    test('invalidateAll 清除全部', () => {
      cache.set('k1', ['r1'], { query: 'Q1' })
      cache.set('k2', ['r2'], { query: 'Q2' })
      expect(cache.stats.entries).toBe(2)

      cache.invalidateAll()
      expect(cache.stats.entries).toBe(0)
      expect(cache.get('k1')).toBeUndefined()
      expect(cache.get('k2')).toBeUndefined()
    })

    test('onWrite 在 writeInvalidate=true 时按标签失效', () => {
      const k = makeQueryCacheKey('Q')
      cache.set(k, ['r'], { query: 'Q', tags: ['Person'] })

      const count = cache.onWrite(['Person'])
      expect(count).toBe(1)
      expect(cache.get(k)).toBeUndefined()
    })

    test('onWrite 在无标签时全量失效', () => {
      cache.set('k1', ['r1'], { query: 'Q1', tags: ['Person'] })
      cache.set('k2', ['r2'], { query: 'Q2', tags: ['Company'] })

      const count = cache.onWrite()
      expect(count).toBe(2)
      expect(cache.stats.entries).toBe(0)
    })

    test('onWrite 在 writeInvalidate=false 时无操作', () => {
      const noopCache = new QueryResultCache({ writeInvalidate: false })
      noopCache.set('k', ['r'], { query: 'Q', tags: ['Person'] })
      expect(noopCache.stats.entries).toBe(1)

      noopCache.onWrite(['Person'])
      // 不应失效
      expect(noopCache.stats.entries).toBe(1)
    })
  })

  describe('makeQueryCacheKey', () => {
    test('相同查询产生相同 key', () => {
      const k1 = makeQueryCacheKey('MATCH (n:Person) RETURN n')
      const k2 = makeQueryCacheKey('MATCH (n:Person) RETURN n')
      expect(k1).toBe(k2)
    })

    test('不同查询产生不同 key', () => {
      const k1 = makeQueryCacheKey('MATCH (n:Person) RETURN n')
      const k2 = makeQueryCacheKey('MATCH (n:Company) RETURN n')
      expect(k1).not.toBe(k2)
    })

    test('key 是十六进制字符串', () => {
      const key = makeQueryCacheKey('TEST')
      expect(key).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('TTL 过期', () => {
    test('TTL 到期后 get 返回 undefined', async () => {
      const shortCache = new QueryResultCache({ maxSize: 10, ttlSec: 0 }) // 立即过期
      const k = makeQueryCacheKey('Q')
      shortCache.set(k, ['r'], { query: 'Q' })

      // 略微等待让 TTL 生效
      await new Promise(r => setTimeout(r, 10))

      expect(shortCache.get(k)).toBeUndefined()
      expect(shortCache.stats.misses).toBe(1)
    })
  })

  describe('边缘情况', () => {
    test('处理大量条目不崩溃（LRU 淘汰）', () => {
      const smallCache = new QueryResultCache({ maxSize: 3, ttlSec: 60 })
      smallCache.set('a', ['r'], { query: 'A' })
      smallCache.set('b', ['r'], { query: 'B' })
      smallCache.set('c', ['r'], { query: 'C' })
      expect(smallCache.stats.entries).toBe(3)

      // 超出最大容量，应淘汰 LRU
      smallCache.set('d', ['r'], { query: 'D' })
      expect(smallCache.stats.entries).toBe(3) // 淘汰一个

      // 被淘汰的是 'a'（最早插入且未被访问）
      expect(smallCache.get('a')).toBeUndefined()
    })

    test('空标签列表的 set 操作', () => {
      const k = makeQueryCacheKey('Q')
      cache.set(k, ['r'], { query: 'Q', tags: [] })
      expect(cache.get(k)).toBeDefined()
      expect(cache.stats.entries).toBe(1)
    })
  })
})
