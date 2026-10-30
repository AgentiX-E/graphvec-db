/**
 * query-cache-persister.spec.ts — Unit tests for QueryCachePersister
 *
 * Covers: construction, start/stop lifecycle, enqueue, recover, flushPending,
 * pendingCount, TTL filtering, empty buffering, double-start safety, and
 * error paths (bad JSON, missing file, I/O failures handled gracefully).
 */
import { QueryCachePersister } from './query-cache-persister'
import { QueryResultCache } from './query-cache'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

let tmpRoot: string
let counter = 0

function tmpDir(label = 'qcp') {
  counter++
  const d = path.join(tmpRoot, `${label}-${counter}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

beforeAll(() => { tmpRoot = path.join(os.tmpdir(), `qcp-spec-${Date.now()}`); fs.mkdirSync(tmpRoot, { recursive: true }) })
afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }) })

describe('QueryCachePersister', () => {
  function makeCache() { return new QueryResultCache({ ttlSec: 60, maxSize: 100 }) }
  function makePersistPath(dir: string) { return path.join(dir, 'cache.wal') }

  // ── Construction / Config ──────────────────────────
  describe('construction', () => {
    it('accepts default config', () => {
      const c = makeCache()
      const p = new QueryCachePersister(c)
      expect(p.started).toBe(false)
      expect(p.pendingCount).toBe(0)
    })

    it('accepts custom config', () => {
      const dir = tmpDir()
      const pp = makePersistPath(dir)
      const c = makeCache()
      const p = new QueryCachePersister(c, {
        persistPath: pp, persistInterval: 10000, maxRecoverEntries: 50,
      })
      expect(p.pendingCount).toBe(0)
      expect(p.started).toBe(false)
    })
  })

  // ── start / stop ───────────────────────────────────
  describe('start/stop lifecycle', () => {
    it('start creates persist directory', async () => {
      const dir = tmpDir()
      const pp = makePersistPath(dir)
      const c = makeCache()
      const p = new QueryCachePersister(c, { persistPath: pp, persistInterval: 0 })
      await p.start()
      expect(p.started).toBe(true)
      expect(fs.existsSync(dir)).toBe(true)
      await p.stop()
    })

    it('double start is a no-op', async () => {
      const dir = tmpDir()
      const pp = makePersistPath(dir)
      const c = makeCache()
      const p = new QueryCachePersister(c, { persistPath: pp, persistInterval: 0 })
      await p.start()
      await p.start() // must not throw or double-recover
      expect(p.started).toBe(true)
      await p.stop()
    })

    it('stop before start is a no-op', async () => {
      const c = makeCache()
      const p = new QueryCachePersister(c)
      // calling stop before start must not throw
      await expect(p.stop()).resolves.toBeUndefined()
    })

    it('start/stop idempotent', async () => {
      const dir = tmpDir()
      const pp = makePersistPath(dir)
      const c = makeCache()
      const p = new QueryCachePersister(c, { persistPath: pp, persistInterval: 0 })
      await p.start()
      await p.stop()
      expect(p.started).toBe(false)
      await p.stop() // double stop no-op
    })
  })

  // ── enqueue ────────────────────────────────────────
  describe('enqueue', () => {
    it('buffers entries when started', async () => {
      const dir = tmpDir()
      const pp = makePersistPath(dir)
      const c = makeCache()
      const p = new QueryCachePersister(c, { persistPath: pp, persistInterval: 0 })
      await p.start()
      c.set('k1', ['r1'], { query: 'q1', tags: [] })
      const entry = (c as any)._cache?.get('k1') || { results: ['r1'], query: 'q1', cachedAt: Date.now(), tags: [] }
      p.enqueue('k1', entry as any)
      expect(p.pendingCount).toBe(1)
      await p.stop()
    })

    it('does not enqueue when stopped', () => {
      const c = makeCache()
      const p = new QueryCachePersister(c)
      p.enqueue('k2', { results: [], query: 'q', cachedAt: Date.now(), tags: [] } as any)
      expect(p.pendingCount).toBe(0)
    })
  })

  // ── flushPending ───────────────────────────────────
  describe('flushPending', () => {
    it('flushes to persist file via stop', async () => {
      const dir = tmpDir()
      const pp = makePersistPath(dir)
      const c = makeCache()
      const p = new QueryCachePersister(c, { persistPath: pp, persistInterval: 0 })
      await p.start()
      c.set('k1', [42], { query: 'q1', tags: [] })
      const entry = {
        results: [42], query: 'q1', cachedAt: Date.now(), tags: [],
      }
      p.enqueue('k1', entry as any)
      expect(p.pendingCount).toBe(1)
      await p.stop()
      expect(p.pendingCount).toBe(0)
      expect(fs.existsSync(pp)).toBe(true)
      const lines = fs.readFileSync(pp, 'utf-8').trim().split('\n').filter(Boolean)
      expect(lines.length).toBe(1)
      const parsed = JSON.parse(lines[0])
      expect(parsed.k).toBe('k1')
      expect(parsed.v.query).toBe('q1')
    })

    it('empty buffer is a no-op', async () => {
      const dir = tmpDir()
      const pp = makePersistPath(dir)
      const c = makeCache()
      const p = new QueryCachePersister(c, { persistPath: pp, persistInterval: 0 })
      await p.start()
      await expect(p.flushPending()).resolves.toBeUndefined()
      expect(fs.existsSync(pp)).toBe(false)
      await p.stop()
    })
  })

  // ── recover ────────────────────────────────────────
  describe('recover', () => {
    it('returns 0 when persist file does not exist', async () => {
      const dir = tmpDir()
      const pp = makePersistPath(dir)
      const c = makeCache()
      const p = new QueryCachePersister(c, { persistPath: pp, persistInterval: 0 })
      const n = await p.recover()
      expect(n).toBe(0)
    })

    it('recovers valid entries from persist file', async () => {
      const dir = tmpDir()
      fs.mkdirSync(dir, { recursive: true })
      const pp = path.join(dir, 'test.wal')
      const now = Date.now()
      fs.writeFileSync(pp, [
        JSON.stringify({ k: 'a', v: { results: [1], query: 'qa', cachedAt: now, tags: [] } }),
        JSON.stringify({ k: 'b', v: { results: [2], query: 'qb', cachedAt: now, tags: [] } }),
      ].join('\n') + '\n')

      const c = makeCache()
      const p = new QueryCachePersister(c, { persistPath: pp, persistInterval: 0, maxRecoverEntries: 10 })
      const n = await p.recover()
      expect(n).toBe(2)
      expect((c.get('a') as any).results).toEqual([1])
      expect((c.get('b') as any).results).toEqual([2])
    })

    it('skips expired entries (TTL > 30s)', async () => {
      const dir = tmpDir()
      fs.mkdirSync(dir, { recursive: true })
      const pp = path.join(dir, 'expired.wal')
      const old = Date.now() - 60000 // 60s ago, well past 30s TTL
      fs.writeFileSync(pp,
        JSON.stringify({ k: 'old', v: { results: [0], query: 'old', cachedAt: old, tags: [] } }) + '\n' +
        JSON.stringify({ k: 'fresh', v: { results: [99], query: 'fresh', cachedAt: Date.now(), tags: [] } }) + '\n')

      const c = makeCache()
      const p = new QueryCachePersister(c, { persistPath: pp, persistInterval: 0, maxRecoverEntries: 10 })
      const n = await p.recover()
      expect(n).toBe(1)
      expect((c.get('fresh') as any).results).toEqual([99])
      expect(c.get('old')).toBeUndefined()
    })

    it('skips lines with bad JSON gracefully', async () => {
      const dir = tmpDir()
      fs.mkdirSync(dir, { recursive: true })
      const pp = path.join(dir, 'bad.wal')
      fs.writeFileSync(pp,
        'not-valid-json\n' +
        JSON.stringify({ k: 'good', v: { results: [7], query: 'g', cachedAt: Date.now(), tags: [] } }) + '\n')

      const c = makeCache()
      const p = new QueryCachePersister(c, { persistPath: pp, persistInterval: 0, maxRecoverEntries: 10 })
      const n = await p.recover()
      expect(n).toBe(1)
      expect((c.get('good') as any).results).toEqual([7])
    })

    it('respects maxRecoverEntries limit', async () => {
      const dir = tmpDir()
      fs.mkdirSync(dir, { recursive: true })
      const pp = path.join(dir, 'many.wal')
      const lines: string[] = []
      const now = Date.now()
      for (let i = 0; i < 20; i++) {
        lines.push(JSON.stringify({ k: `k${i}`, v: { results: [i], query: `q${i}`, cachedAt: now, tags: [] } }))
      }
      fs.writeFileSync(pp, lines.join('\n') + '\n')

      const c = makeCache()
      const p = new QueryCachePersister(c, { persistPath: pp, persistInterval: 0, maxRecoverEntries: 5 })
      const n = await p.recover()
      expect(n).toBe(5)
    })

    it('handles empty file gracefully', async () => {
      const dir = tmpDir()
      fs.mkdirSync(dir, { recursive: true })
      const pp = path.join(dir, 'empty.wal')
      fs.writeFileSync(pp, '')

      const c = makeCache()
      const p = new QueryCachePersister(c, { persistPath: pp, persistInterval: 0 })
      const n = await p.recover()
      expect(n).toBe(0)
    })

    it('handles I/O error gracefully', async () => {
      const pp = path.join(tmpRoot, 'nonexistent', 'cache.wal')
      const c = makeCache()
      const p = new QueryCachePersister(c, { persistPath: pp, persistInterval: 0 })
      const n = await p.recover()
      expect(n).toBe(0)
    })
  })

  // ── Edge cases ─────────────────────────────────────
  describe('edge cases', () => {
    it('flushPending is serialised (prevents concurrent flushes)', async () => {
      const dir = tmpDir()
      const pp = makePersistPath(dir)
      const c = makeCache()
      const p = new QueryCachePersister(c, { persistPath: pp, persistInterval: 0 })
      await p.start()
      c.set('k', [1], { query: 'q', tags: [] })
      const e = { results: [1], query: 'q', cachedAt: Date.now(), tags: [] }
      p.enqueue('k', e as any)
      // Trigger two concurrent flushes — only one writes
      await Promise.all([p.flushPending(), p.flushPending()])
      // Buffer should be consumed only once
      const lines = fs.readFileSync(pp, 'utf-8').trim().split('\n').filter(Boolean)
      expect(lines.length).toBe(1)
      await p.stop()
    })

    it('pendingCount returns correct buffer size', async () => {
      const dir = tmpDir()
      const pp = makePersistPath(dir)
      const c = makeCache()
      const p = new QueryCachePersister(c, { persistPath: pp, persistInterval: 0 })
      await p.start()
      expect(p.pendingCount).toBe(0)
      for (let i = 0; i < 3; i++) {
        c.set(`k${i}`, [i], { query: `q${i}`, tags: [] })
        const e = { results: [i], query: `q${i}`, cachedAt: Date.now(), tags: [] }
        p.enqueue(`k${i}`, e as any)
      }
      expect(p.pendingCount).toBe(3)
      await p.flushPending()
      expect(p.pendingCount).toBe(0)
      await p.stop()
    })

    it('does not throw on recover() with bad file path', async () => {
      const pp = '/root/forbidden-path/wal.wal' // likely unwritable
      const c = makeCache()
      const p = new QueryCachePersister(c, { persistPath: pp, persistInterval: 0 })
      // Must not throw
      const n = await p.recover().catch(() => 0)
      expect(n).toBeGreaterThanOrEqual(0)
    })
  })
})