// ============================================================
// OverGraphStorage — Edge write cache tests
//
// 验证 JS 层 workaround 对 Rust read-your-write 不一致的修复：
// - upsertEdge 后 getEdge 能返回正确的 props
// - deleteEdge 后 getEdge 返回 null
// - 缓存有 LRU 淘汰逻辑
// ============================================================

import { OverGraphStorage } from './overgraph-storage'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'og-cache-test-'))
}

describe('OverGraphStorage — Edge write cache', () => {
  let storage: OverGraphStorage
  let tmpDir: string

  beforeAll(() => {
    tmpDir = makeTempDir()
    storage = new OverGraphStorage()
    storage.open({ path: tmpDir })
  })

  afterAll(() => {
    storage.close()
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  beforeEach(() => {
    // Close and reopen to get a clean state for each test
    storage.close()
    // Clean the DB directory
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    fs.mkdirSync(tmpDir, { recursive: true })
    storage.open({ path: tmpDir })
  })

  // ── Test 1: upsertEdge → getEdge 读自己写 (Read-Your-Write) ──

  test('P1-R1: upsertEdge followed by getEdge returns correct props', () => {
    const src = storage.upsertNode(1, 'alice', { props: { name: 'Alice' } })
    const dst = storage.upsertNode(1, 'bob', { props: { name: 'Bob' } })

    // 写入边并设置 props
    storage.upsertEdge(src, dst, 5, {
      props: { weight: '1.0', label: 'friend' },
    })

    // 立即读取 — 应返回刚刚写入的 props
    const edge = storage.getEdge(src, dst, 5)
    expect(edge).not.toBeNull()
    expect(edge!.from).toBe(src)
    expect(edge!.to).toBe(dst)
    expect(edge!.typeId).toBe(5)
    expect(edge!.props).toBeDefined()
    expect(edge!.props!['weight']).toBe('1.0')
    expect(edge!.props!['label']).toBe('friend')
  })

  test('P1-R2: upsertEdge update props — getEdge sees latest', () => {
    const src = storage.upsertNode(1, 'alice2', { props: { name: 'Alice' } })
    const dst = storage.upsertNode(1, 'bob2', { props: { name: 'Bob' } })

    // 第一次写入
    storage.upsertEdge(src, dst, 99, { props: { weight: '1.0' } })

    // 更新
    storage.upsertEdge(src, dst, 99, { props: { weight: '2.0', label: 'updated' } })

    // 读取 — 应返回最新 props
    const edge = storage.getEdge(src, dst, 99)
    expect(edge).not.toBeNull()
    expect(edge!.props!['weight']).toBe('2.0')
    expect(edge!.props!['label']).toBe('updated')
  })

  test('P1-R3: typeId parameter is respected by getEdge', () => {
    const src = storage.upsertNode(1, 'alice3', { props: { name: 'Alice' } })
    const dst = storage.upsertNode(1, 'bob3', { props: { name: 'Bob' } })

    // 写入两个不同 typeId 的边
    storage.upsertEdge(src, dst, 5, { props: { rel: 'type5' } })
    storage.upsertEdge(src, dst, 7, { props: { rel: 'type7' } })

    // 用 typeId=5 查询 — 应返回 type5 的边
    const edge5 = storage.getEdge(src, dst, 5)
    expect(edge5).not.toBeNull()
    expect(edge5!.typeId).toBe(5)
    expect(edge5!.props!['rel']).toBe('type5')

    // 用 typeId=7 查询 — 应返回 type7 的边
    const edge7 = storage.getEdge(src, dst, 7)
    expect(edge7).not.toBeNull()
    expect(edge7!.typeId).toBe(7)
    expect(edge7!.props!['rel']).toBe('type7')
  })

  // ── Test 2: deleteEdge → getEdge ──

  test('P1-R4: deleteEdge clears cache — getEdge returns null', () => {
    const src = storage.upsertNode(1, 'alice4', { props: { name: 'Alice' } })
    const dst = storage.upsertNode(1, 'bob4', { props: { name: 'Bob' } })

    // 写入
    storage.upsertEdge(src, dst, 3, { props: { weight: '1.0' } })

    // 确认可读
    const before = storage.getEdge(src, dst, 3)
    expect(before).not.toBeNull()

    // 删除
    const deleted = storage.deleteEdge(src, dst, 3)
    expect(deleted).toBe(true)

    // 删除后读取 — 应为 null
    const after = storage.getEdge(src, dst, 3)
    expect(after).toBeNull()
  })

  test('P1-R5: deleteEdge on non-existent edge returns false', () => {
    const result = storage.deleteEdge(999, 1000, 42)
    expect(result).toBe(false)
  })

  // ── Test 3: LRU 淘汰 ──

  test('P1-R6: cache LRU eviction when exceeding capacity', () => {
    // 使用一个临时的小容量 LRU 来验证淘汰逻辑
    const src = storage.upsertNode(1, 'lru-src', { props: { name: 'LRU' } })
    const dst = storage.upsertNode(1, 'lru-dst2', { props: { name: 'LRU2' } })
    expect(src).toBeGreaterThan(0)
    expect(dst).toBeGreaterThan(0)

    // 写入超过 1000 条不同的边
    const count = 1100
    for (let i = 0; i < count; i++) {
      storage.upsertEdge(src + i, dst + i + 10000, 1, {
        props: { idx: String(i) },
      })
    }

    // 缓存最多 1000 条，所以早期写入的边应该被淘汰了
    // 最新的几条应该还能从缓存命中
    const stats = storage.edgeCacheStats
    expect(stats.size).toBeLessThanOrEqual(1000)

    // 最后 100 条应该还在缓存中
    for (let i = count - 100; i < count; i++) {
      const edge = storage.getEdge(src + i, dst + i + 10000, 1)
      expect(edge).not.toBeNull()
      expect(edge!.props!['idx']).toBe(String(i))
    }

    // 缓存命中应至少 100 次
    expect(storage.edgeCacheStats.hits).toBeGreaterThanOrEqual(100)
  })

  // ── Test 4: batchUpsertEdges cache consistency ──

  test('P1-R7: batchUpsertEdges followed by getEdge returns correct props', () => {
    const src = storage.upsertNode(1, 'batch-src', { props: { name: 'Batch' } })
    const dst = storage.upsertNode(1, 'batch-dst', { props: { name: 'Batch' } })

    storage.batchUpsertEdges([
      { src, dst, typeId: 10, props: { rel: 'batch10' } },
      { src, dst: dst + 1, typeId: 11, props: { rel: 'batch11' } },
    ])

    // 验证缓存命中
    const edge10 = storage.getEdge(src, dst, 10)
    expect(edge10).not.toBeNull()
    expect(edge10!.props!['rel']).toBe('batch10')
  })

  // ── Test 5: cache stats reporting ──

  test('P1-R8: edgeCacheStats reports correctly', () => {
    const src = storage.upsertNode(1, 'stat-src', { props: {} })
    const dst = storage.upsertNode(1, 'stat-dst', { props: {} })

    const before = storage.edgeCacheStats
    expect(before.size).toBe(0)

    // 写入 → 缓存增加
    storage.upsertEdge(src, dst, 1, { props: { v: '1' } })
    expect(storage.edgeCacheStats.size).toBe(1)

    // 读取命中
    storage.getEdge(src, dst, 1)
    expect(storage.edgeCacheStats.hits).toBeGreaterThan(0)

    // 读取未命中的 edge（不存在）
    storage.getEdge(99999, 88888, 999)
    expect(storage.edgeCacheStats.misses).toBeGreaterThan(0)
  })
})
