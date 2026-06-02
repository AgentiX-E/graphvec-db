import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { QueryResultCache, makeQueryCacheKey } from './query-cache'
import { QueryCachePersister } from './query-cache-persister'
import * as fs from 'node:fs'
import * as path from 'node:path'

const TEST_DIR = path.resolve(__dirname, '../../test-data')
const TEST_WAL = path.join(TEST_DIR, 'cache-persist-test.wal')

describe('QueryCachePersister', () => {
  let cache: QueryResultCache
  let persister: QueryCachePersister

  beforeEach(() => {
    if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true })
    try { fs.unlinkSync(TEST_WAL) } catch {}
    cache = new QueryResultCache({ maxSize: 100, ttlSec: 60 })
  })

  afterEach(async () => {
    if (persister) await persister.stop()
    try { fs.unlinkSync(TEST_WAL) } catch {}
  })

  test('should create with default config', () => {
    persister = new QueryCachePersister(cache)
    expect(persister.started).toBe(false)
  })

  test('should create with custom config', () => {
    persister = new QueryCachePersister(cache, {
      persistPath: TEST_WAL, persistInterval: 10000, maxRecoverEntries: 500,
    })
    expect(persister).toBeDefined()
  })

  test('should start and create directory', async () => {
    persister = new QueryCachePersister(cache, { persistPath: TEST_WAL, persistInterval: 0 })
    await persister.start()
    expect(persister.started).toBe(true)
    expect(fs.existsSync(TEST_DIR)).toBe(true)
  })

  test('start is idempotent', async () => {
    persister = new QueryCachePersister(cache, { persistPath: TEST_WAL, persistInterval: 0 })
    await persister.start()
    await persister.start()
    expect(persister.started).toBe(true)
  })

  test('should queue entries', async () => {
    persister = new QueryCachePersister(cache, { persistPath: TEST_WAL, persistInterval: 0 })
    await persister.start()
    persister.enqueue(makeQueryCacheKey('Q1'), { results: ['r1'], query: 'Q1', cachedAt: Date.now(), tags: [] })
    expect(persister.pendingCount).toBe(1)
  })

  test('should flush entries to WAL file', async () => {
    persister = new QueryCachePersister(cache, { persistPath: TEST_WAL, persistInterval: 0 })
    await persister.start()
    persister.enqueue(makeQueryCacheKey('Q1'), { results: [{ id: 1, name: 'Alice' }], query: 'Q1', cachedAt: Date.now(), tags: ['Person'] })
    await persister.flushPending()
    expect(persister.pendingCount).toBe(0)
    const content = fs.readFileSync(TEST_WAL, 'utf-8')
    expect(content).toContain('Q1')
    expect(content).toContain('Alice')
  })

  test('should flush multiple entries', async () => {
    persister = new QueryCachePersister(cache, { persistPath: TEST_WAL, persistInterval: 0 })
    await persister.start()
    persister.enqueue(makeQueryCacheKey('Q1'), { results: ['r1'], query: 'Q1', cachedAt: Date.now(), tags: ['A'] })
    persister.enqueue(makeQueryCacheKey('Q2'), { results: ['r2'], query: 'Q2', cachedAt: Date.now(), tags: ['B'] })
    await persister.flushPending()
    const lines = fs.readFileSync(TEST_WAL, 'utf-8').split('\n').filter(Boolean)
    expect(lines.length).toBe(2)
  })

  test('should flush on stop', async () => {
    persister = new QueryCachePersister(cache, { persistPath: TEST_WAL, persistInterval: 0 })
    await persister.start()
    persister.enqueue(makeQueryCacheKey('Q-stop'), { results: ['stop'], query: 'Q-stop', cachedAt: Date.now(), tags: [] })
    await persister.stop()
    expect(fs.readFileSync(TEST_WAL, 'utf-8')).toContain('Q-stop')
  })

  test('should recover persisted entries', async () => {
    const p1 = new QueryCachePersister(cache, { persistPath: TEST_WAL, persistInterval: 0 })
    await p1.start()
    p1.enqueue(makeQueryCacheKey('recover-key'), { results: [{ id: 99, name: 'Recovered' }], query: 'recover-key', cachedAt: Date.now(), tags: ['Test'] })
    await p1.flushPending()
    await p1.stop()

    const cache2 = new QueryResultCache({ maxSize: 100, ttlSec: 60 })
    const p2 = new QueryCachePersister(cache2, { persistPath: TEST_WAL, persistInterval: 0 })
    const recovered = await p2.recover()
    expect(recovered).toBeGreaterThanOrEqual(1)
    const entry = cache2.get(makeQueryCacheKey('recover-key'))
    expect(entry).toBeDefined()
    expect(entry!.results).toEqual([{ id: 99, name: 'Recovered' }])
    await p2.stop()
  })

  test('should skip expired entries during recovery', async () => {
    const p1 = new QueryCachePersister(cache, { persistPath: TEST_WAL, persistInterval: 0 })
    await p1.start()
    p1.enqueue(makeQueryCacheKey('expired'), { results: ['old'], query: 'expired', cachedAt: Date.now() - 3600000, tags: [] })
    p1.enqueue(makeQueryCacheKey('valid'), { results: ['new'], query: 'valid', cachedAt: Date.now(), tags: [] })
    await p1.flushPending()
    await p1.stop()

    const cache2 = new QueryResultCache({ maxSize: 100, ttlSec: 60 })
    const p2 = new QueryCachePersister(cache2, { persistPath: TEST_WAL, persistInterval: 0 })
    const recovered = await p2.recover()
    expect(recovered).toBeGreaterThanOrEqual(1)
    expect(cache2.get(makeQueryCacheKey('expired'))).toBeUndefined()
    expect(cache2.get(makeQueryCacheKey('valid'))).toBeDefined()
    await p2.stop()
  })

  test('should handle non-existent WAL file', async () => {
    try { fs.unlinkSync(TEST_WAL) } catch {}
    persister = new QueryCachePersister(cache, { persistPath: TEST_WAL, persistInterval: 0 })
    expect(await persister.recover()).toBe(0)
  })

  test('should recover at most maxEntries', async () => {
    const p1 = new QueryCachePersister(cache, { persistPath: TEST_WAL, persistInterval: 0 })
    await p1.start()
    for (let i = 0; i < 10; i++) {
      p1.enqueue(makeQueryCacheKey(`Q${i}`), { results: [`r${i}`], query: `Q${i}`, cachedAt: Date.now(), tags: [] })
    }
    await p1.flushPending()
    await p1.stop()

    const cache2 = new QueryResultCache({ maxSize: 100, ttlSec: 60 })
    const p2 = new QueryCachePersister(cache2, { persistPath: TEST_WAL, persistInterval: 0 })
    expect(await p2.recover(5)).toBe(5)
    expect(cache2.get(makeQueryCacheKey('Q0'))).toBeUndefined()
    expect(cache2.get(makeQueryCacheKey('Q9'))).toBeDefined()
    await p2.stop()
  })

  test('should handle malformed WAL lines', async () => {
    const k1 = makeQueryCacheKey('v1')
    const k2 = makeQueryCacheKey('v2')
    fs.writeFileSync(TEST_WAL, JSON.stringify({ k: k1, v: { results: ['ok'], query: 'v1', cachedAt: Date.now(), tags: [] } }) + '\nnot-json\n' + JSON.stringify({ k: k2, v: { results: ['ok2'], query: 'v2', cachedAt: Date.now(), tags: [] } }) + '\n')
    persister = new QueryCachePersister(cache, { persistPath: TEST_WAL, persistInterval: 0 })
    expect(await persister.recover()).toBe(2)
  })

  test('should not crash on invalid persist path', async () => {
    persister = new QueryCachePersister(cache, { persistPath: '/nonexistent/deep/dir/cache.wal', persistInterval: 0 })
    await expect(persister.start()).resolves.not.toThrow()
  })

  test('enqueue after stop is noop', async () => {
    persister = new QueryCachePersister(cache, { persistPath: TEST_WAL, persistInterval: 0 })
    await persister.start()
    await persister.stop()
    expect(() => persister.enqueue(makeQueryCacheKey('after-stop'), { results: ['x'], query: 'after-stop', cachedAt: Date.now(), tags: [] })).not.toThrow()
  })

  test('should auto-flush on interval', async () => {
    persister = new QueryCachePersister(cache, { persistPath: TEST_WAL, persistInterval: 100 })
    await persister.start()
    persister.enqueue(makeQueryCacheKey('auto-flush'), { results: ['auto'], query: 'auto-flush', cachedAt: Date.now(), tags: [] })
    await new Promise(r => setTimeout(r, 200))
    const content = fs.readFileSync(TEST_WAL, 'utf-8')
    expect(content).toContain('auto-flush')
    await persister.stop()
  })
})
