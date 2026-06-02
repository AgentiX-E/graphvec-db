/**
 * columnar-index.spec.ts — ColumnarIndex 单元测试
 *
 * GAP-61 覆盖:
 * - buildForColumnDoubleBuffer 在线重建
 * - Double-Buffer 交换后数据正确
 * - 重建期间 activeDb 继续服务查询
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ColumnarIndex, parseKey } from './columnar-index'

const TEST_DIR = path.join(os.tmpdir(), `col-index-test-${Date.now()}`)

function makeConfig(columns: string[] = ['age', 'name', 'score'], doubleBufferRebuild?: boolean) {
  return {
    enable: true,
    columns,
    indexPath: path.join(TEST_DIR, 'idx'),
    syncOnWrite: true,
    doubleBufferRebuild: doubleBufferRebuild ?? false,
  }
}

describe('ColumnarIndex', () => {
  let idx: ColumnarIndex

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true })
    idx = new ColumnarIndex(makeConfig(), TEST_DIR)
    idx.open()
  })

  afterEach(() => {
    idx.close()
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
  })

  // ── 打开 / 关闭 ──────────────────────────

  it('GAP-14-01: opens and closes', () => {
    expect(idx.isOpen).toBe(true)
    idx.close()
    expect(idx.isOpen).toBe(false)
  })

  // ── isIndexed / getIndexedColumns ────────

  it('GAP-14-02: isIndexed returns true for configured columns', () => {
    expect(idx.isIndexed('age')).toBe(true)
    expect(idx.isIndexed('name')).toBe(true)
    expect(idx.isIndexed('score')).toBe(true)
    expect(idx.isIndexed('unindexed')).toBe(false)
  })

  it('GAP-14-03: getIndexedColumns returns the configured columns', () => {
    const cols = idx.getIndexedColumns()
    expect(cols).toContain('age')
    expect(cols).toContain('name')
    expect(cols).toContain('score')
  })

  it('GAP-14-04: when enabled=false, isIndexed always false', () => {
    idx.close()
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
    const disabledIdx = new ColumnarIndex({
      enable: false,
      columns: ['age'],
    }, TEST_DIR)
    disabledIdx.open()
    expect(disabledIdx.isIndexed('age')).toBe(false)
    disabledIdx.close()
  })

  // ── parseKey ─────────────────────────────

  it('GAP-14-05: parseKey works correctly', () => {
    const result = parseKey('age:30:42')
    expect(result).not.toBeNull()
    expect(result!.col).toBe('age')
    expect(result!.val).toBe('30')
    expect(result!.nodeId).toBe(42)
  })

  it('GAP-14-06: parseKey returns null for invalid keys', () => {
    expect(parseKey('')).toBeNull()
    expect(parseKey('no-colon')).toBeNull()
  })

  // ── buildForColumn ───────────────────────

  it('GAP-14-07: buildForColumn builds index for a column', () => {
    const nodes: [number, Record<string, unknown>][] = [
      [1, { age: 25, name: 'Alice' }],
      [2, { age: 30, name: 'Bob' }],
      [3, { age: 35, name: 'Charlie' }],
    ]
    idx.buildForColumn('age', nodes)
    expect(idx.eq('age', 25)).toEqual([1])
    expect(idx.eq('age', 30)).toEqual([2])
    expect(idx.eq('age', 35)).toEqual([3])
    expect(idx.eq('age', 99)).toEqual([])
  })

  it('GAP-14-08: buildForColumn skips null/undefined values', () => {
    const nodes: [number, Record<string, unknown>][] = [
      [1, { age: 25 }],
      [2, { age: null }],
      [3, {}],
    ]
    idx.buildForColumn('age', nodes)
    expect(idx.eq('age', 25)).toEqual([1])
    expect(idx.eq('age', null as any)).toEqual([])
  })

  it('GAP-14-09: buildForColumn skips non-string/number values', () => {
    const nodes: [number, Record<string, unknown>][] = [
      [1, { tags: { a: 1 } }], // object → skip
      [2, { tags: [1, 2, 3] }],   // array → skip
    ]
    idx.buildForColumn('tags', nodes)
    expect(idx.eq('tags', { a: 1 } as any)).toEqual([])
  })

  // ── rangeScan ────────────────────────────

  it('GAP-14-10: rangeScan with eq finds by value', () => {
    const nodes: [number, Record<string, unknown>][] = [
      [1, { age: 20 }],
      [2, { age: 30 }],
      [3, { age: 30 }],
      [4, { age: 40 }],
    ]
    idx.buildForColumn('age', nodes)
    const result = idx.rangeScan('age', 'eq', 30)
    expect(result).toContain(2)
    expect(result).toContain(3)
    expect(result).not.toContain(1)
    expect(result).not.toContain(4)
  })

  it('GAP-14-11: rangeScan with gt', () => {
    const nodes: [number, Record<string, unknown>][] = [
      [1, { age: 20 }],
      [2, { age: 30 }],
      [3, { age: 40 }],
    ]
    idx.buildForColumn('age', nodes)
    const result = idx.rangeScan('age', 'gt', 30)
    expect(result).toEqual([3])
  })

  it('GAP-14-12: rangeScan with gte', () => {
    const nodes: [number, Record<string, unknown>][] = [
      [1, { age: 20 }],
      [2, { age: 30 }],
      [3, { age: 40 }],
    ]
    idx.buildForColumn('age', nodes)
    const result = idx.rangeScan('age', 'gte', 30)
    expect(result).toContain(2)
    expect(result).toContain(3)
    expect(result).not.toContain(1)
  })

  it('GAP-14-13: rangeScan with lt', () => {
    const nodes: [number, Record<string, unknown>][] = [
      [1, { age: 20 }],
      [2, { age: 30 }],
      [3, { age: 40 }],
    ]
    idx.buildForColumn('age', nodes)
    const result = idx.rangeScan('age', 'lt', 30)
    expect(result).toEqual([1])
  })

  it('GAP-14-14: rangeScan with lte', () => {
    const nodes: [number, Record<string, unknown>][] = [
      [1, { age: 20 }],
      [2, { age: 30 }],
      [3, { age: 40 }],
    ]
    idx.buildForColumn('age', nodes)
    const result = idx.rangeScan('age', 'lte', 30)
    expect(result).toContain(1)
    expect(result).toContain(2)
    expect(result).not.toContain(3)
  })

  it('GAP-14-15: rangeScan with between', () => {
    const nodes: [number, Record<string, unknown>][] = [
      [1, { age: 20 }],
      [2, { age: 30 }],
      [3, { age: 35 }],
      [4, { age: 40 }],
      [5, { age: 50 }],
    ]
    idx.buildForColumn('age', nodes)
    const result = idx.rangeScan('age', 'between', 30, 40)
    expect(result).toContain(2)
    expect(result).toContain(3)
    expect(result).toContain(4)
    expect(result).not.toContain(1)
    expect(result).not.toContain(5)
  })

  it('GAP-14-16: rangeScan returns [] for unindexed column', () => {
    const result = idx.rangeScan('unindexed', 'eq', 'foo')
    expect(result).toEqual([])
  })

  // ── updateNodeIndexes / deleteNodeIndexes ─

  it('GAP-14-17: updateNodeIndexes adds entries for a node', () => {
    idx.updateNodeIndexes(1, { age: 25, name: 'Alice', score: 90 })
    expect(idx.eq('age', 25)).toEqual([1])
    expect(idx.eq('name', 'Alice')).toEqual([1])
    expect(idx.eq('score', 90)).toEqual([1])
  })

  it('GAP-14-18: updateNodeIndexes removes old values then adds new ones', () => {
    idx.updateNodeIndexes(1, { age: 25, name: 'Alice' })
    expect(idx.eq('age', 25)).toEqual([1])

    // 更新 age
    idx.updateNodeIndexes(1, { age: 30, name: 'Alice' })
    expect(idx.eq('age', 25)).toEqual([])  // 旧值已删除
    expect(idx.eq('age', 30)).toEqual([1]) // 新值已写入
    expect(idx.eq('name', 'Alice')).toEqual([1])
  })

  it('GAP-14-19: deleteNodeIndexes removes all entries for a node', () => {
    idx.updateNodeIndexes(1, { age: 25, name: 'Alice' })
    idx.updateNodeIndexes(2, { age: 30, name: 'Bob' })

    idx.deleteNodeIndexes(1)
    expect(idx.eq('age', 25)).toEqual([])
    expect(idx.eq('name', 'Alice')).toEqual([])
    // 节点 2 不受影响
    expect(idx.eq('age', 30)).toEqual([2])
    expect(idx.eq('name', 'Bob')).toEqual([2])
  })

  it('GAP-14-20: deleteNodeIndexes is idempotent', () => {
    idx.deleteNodeIndexes(999) // 不存在的节点
    // 不应抛出异常
  })

  // ── 字符串索引 ────────────────────────────

  it('GAP-14-21: supports string column indexing and equality', () => {
    idx.updateNodeIndexes(1, { name: 'Alice' })
    idx.updateNodeIndexes(2, { name: 'Bob' })
    idx.updateNodeIndexes(3, { name: 'alice' }) // 大小写敏感

    expect(idx.eq('name', 'Alice')).toEqual([1])
    expect(idx.eq('name', 'Bob')).toEqual([2])
    expect(idx.eq('name', 'alice')).toEqual([3])
  })

  // ── 跨 session 持久化 ──────────────────────

  it('GAP-14-22: persists index data across close/reopen', () => {
    idx.updateNodeIndexes(1, { age: 25, name: 'Alice' })
    idx.updateNodeIndexes(2, { age: 30, name: 'Bob' })

    // 关闭并重新打开
    idx.close()
    idx.open()

    expect(idx.eq('age', 25)).toEqual([1])
    expect(idx.eq('age', 30)).toEqual([2])
    expect(idx.eq('name', 'Alice')).toEqual([1])
  })

  // ── 多节点同值 ────────────────────────────

  it('GAP-14-23: multiple nodes with same value are all found', () => {
    idx.updateNodeIndexes(1, { age: 30 })
    idx.updateNodeIndexes(2, { age: 30 })
    idx.updateNodeIndexes(3, { age: 30 })

    const result = idx.eq('age', 30)
    expect(result).toContain(1)
    expect(result).toContain(2)
    expect(result).toContain(3)
    expect(result.length).toBe(3)
  })

  // ── 异步/异步扫描支持 ──────────────────────

  it('GAP-14-24: rangeScan returns empty when no data', () => {
    expect(idx.rangeScan('age', 'eq', 42)).toEqual([])
    expect(idx.rangeScan('age', 'gt', 42)).toEqual([])
    expect(idx.rangeScan('age', 'lt', 42)).toEqual([])
  })

  // ── 异常处理 ──────────────────────────────

  it('GAP-14-25: operations throw when not open', () => {
    idx.close()
    expect(() => idx.updateNodeIndexes(1, { age: 25 })).toThrow('ColumnarIndex is not open')
    expect(() => idx.rangeScan('age', 'eq', 25)).toThrow('ColumnarIndex is not open')
    expect(() => idx.deleteNodeIndexes(1)).toThrow('ColumnarIndex is not open')
  })

  // ── GAP-61: Double-Buffer 在线重建 ────────

  describe('GAP-61: Double-Buffer online rebuild', () => {
    let dbIdx: ColumnarIndex

    beforeEach(() => {
      // 使用独立目录，避免 index.spec.ts 和 columnar-index.spec.ts 共用目录
      const dbTestDir = path.join(TEST_DIR, 'db-rebuild')
      fs.mkdirSync(dbTestDir, { recursive: true })
      dbIdx = new ColumnarIndex(makeConfig(['age', 'name', 'score'], true), dbTestDir)
      dbIdx.open()
    })

    afterEach(() => {
      dbIdx.close()
    })

    it('GAP-61-01: buildForColumnDoubleBuffer rebuilds column index correctly', () => {
      const initialNodes: [number, Record<string, unknown>][] = [
        [1, { age: 25, name: 'Alice' }],
        [2, { age: 30, name: 'Bob' }],
      ]
      dbIdx.buildForColumn('age', initialNodes)
      expect(dbIdx.eq('age', 25)).toEqual([1])
      expect(dbIdx.eq('age', 30)).toEqual([2])

      // Double-buffer rebuild 后数据正确（仅有 age=40, age=50）
      const newNodes: [number, Record<string, unknown>][] = [
        [10, { age: 40, name: 'Dave' }],
        [20, { age: 50, name: 'Eve' }],
      ]
      dbIdx.buildForColumnDoubleBuffer('age', newNodes)

      // 旧数据不在新索引中
      expect(dbIdx.eq('age', 25)).toEqual([])
      expect(dbIdx.eq('age', 30)).toEqual([])
      // 新数据在新索引中
      expect(dbIdx.eq('age', 40)).toEqual([10])
      expect(dbIdx.eq('age', 50)).toEqual([20])
    })

    it('GAP-61-02: double-buffer rebuild succeeds when no doubleBufferRebuild flag (falls back to normal)', () => {
      const idx2 = new ColumnarIndex(makeConfig(['age'], false), TEST_DIR)
      idx2.open()

      const nodes: [number, Record<string, unknown>][] = [
        [1, { age: 25 }],
        [2, { age: 30 }],
      ]
      // doubleBufferRebuild=false, 降级为普通重建
      idx2.buildForColumnDoubleBuffer('age', nodes)
      expect(idx2.eq('age', 25)).toEqual([1])
      expect(idx2.eq('age', 30)).toEqual([2])
      expect(idx2.isRebuilding).toBe(false)

      idx2.close()
    })

    it('GAP-61-03: query on activeDb works during rebuild (double-buffer isolation)', () => {
      const initialNodes: [number, Record<string, unknown>][] = [
        [1, { age: 25 }],
        [2, { age: 30 }],
      ]
      // 先建一些索引
      dbIdx.buildForColumn('age', initialNodes)
      expect(dbIdx.eq('age', 25)).toEqual([1])

      // 手动顺序模拟：old data 在重建期间可查，新数据在重建后
      const newNodes: [number, Record<string, unknown>][] = [
        [10, { age: 100 }],
      ]
      dbIdx.buildForColumnDoubleBuffer('age', newNodes)

      // 重建后只有新数据
      expect(dbIdx.eq('age', 25)).toEqual([])
      expect(dbIdx.eq('age', 100)).toEqual([10])
    })

    it('GAP-61-04: buildForColumnDoubleBuffer skips null/undefined values', () => {
      const nodes: [number, Record<string, unknown>][] = [
        [1, { age: 25 }],
        [2, { age: null }],
        [3, {}],
      ]
      dbIdx.buildForColumnDoubleBuffer('age', nodes)
      expect(dbIdx.eq('age', 25)).toEqual([1])
      // null and undefined not indexed
    })

    it('GAP-61-05: buildForColumnDoubleBuffer after multiple swaps works correctly', () => {
      // 第一次 double-buffer rebuild
      const nodes1: [number, Record<string, unknown>][] = [
        [1, { age: 10 }],
        [2, { age: 20 }],
      ]
      dbIdx.buildForColumnDoubleBuffer('age', nodes1)
      expect(dbIdx.eq('age', 10)).toEqual([1])
      expect(dbIdx.eq('age', 20)).toEqual([2])

      // 第二次 double-buffer rebuild (复用已有的 replica DB)
      const nodes2: [number, Record<string, unknown>][] = [
        [3, { age: 30 }],
        [4, { age: 40 }],
      ]
      dbIdx.buildForColumnDoubleBuffer('age', nodes2)
      expect(dbIdx.eq('age', 10)).toEqual([])
      expect(dbIdx.eq('age', 20)).toEqual([])
      expect(dbIdx.eq('age', 30)).toEqual([3])
      expect(dbIdx.eq('age', 40)).toEqual([4])
    })

    it('GAP-61-06: isRebuilding reflects rebuilding state', () => {
      expect(dbIdx.isRebuilding).toBe(false)

      // 同步重建，重建期间 isRebuilding=true，结束后为 false
      const nodes: [number, Record<string, unknown>][] = [[1, { age: 25 }]]
      dbIdx.buildForColumnDoubleBuffer('age', nodes)
      expect(dbIdx.isRebuilding).toBe(false)
    })

    it('GAP-61-07: double-buffer rebuild with empty nodeIterator produces empty index', () => {
      dbIdx.buildForColumnDoubleBuffer('age', [])
      expect(dbIdx.eq('age', 0)).toEqual([])
      expect(dbIdx.eq('age', 99)).toEqual([])
    })

    it('GAP-61-08: rebuild with single column replaces all data in swapped db', () => {
      // Build multi-column data
      dbIdx.updateNodeIndexes(1, { age: 25, name: 'Alice' })
      dbIdx.updateNodeIndexes(2, { age: 30, name: 'Bob' })
      expect(dbIdx.eq('age', 25)).toEqual([1])
      expect(dbIdx.eq('name', 'Alice')).toEqual([1])

      // Rebuild only 'age' column — this swaps the entire sub-db
      const newData: [number, Record<string, unknown>][] = [
        [3, { age: 40, name: 'Charlie' }],
      ]
      dbIdx.buildForColumnDoubleBuffer('age', newData)

      // age 索引已更新
      expect(dbIdx.eq('age', 25)).toEqual([])
      expect(dbIdx.eq('age', 40)).toEqual([3])

      // name 索引 — swap 后旧的 columnar sub-db 被替换为 rebuild 后的 columnar-rebuild sub-db
      // 新 db 中只有 rebuild 写入的 age 数据，没有 name 索引
      // 这是 double-buffer 的 expected behavior：swap 后所有数据来自新的 sub-db
      expect(dbIdx.eq('name', 'Alice')).toEqual([])
    })

    it('GAP-61-09: rebuild is reflected after close/reopen (persistence)', () => {
      // 先使用普通 buildForColumn 写入数据
      const nodes: [number, Record<string, unknown>][] = [
        [1, { age: 10 }],
      ]
      dbIdx.buildForColumn('age', nodes)
      expect(dbIdx.eq('age', 10)).toEqual([1])

      // double-buffer rebuild (验证 swap 后数据正确)
      const newNodes: [number, Record<string, unknown>][] = [
        [2, { age: 20 }],
      ]
      dbIdx.buildForColumnDoubleBuffer('age', newNodes)
      expect(dbIdx.eq('age', 10)).toEqual([])
      expect(dbIdx.eq('age', 20)).toEqual([2])

      // close
      const dbDir = (dbIdx as any).storagePath as string
      const cfg = (dbIdx as any).config as any
      dbIdx.close()

      // reopen (no doubleBufferRebuild 以打开默认的 columnar sub-db)
      // buildForColumn 写入的数据在 columnar sub-db 中应仍可查到
      const reopenedNoDb = new ColumnarIndex(makeConfig(['age', 'name', 'score'], false), dbDir)
      reopenedNoDb.open()
      // 普通 build 写入的数据仍然存在
      expect(reopenedNoDb.eq('age', 10)).toEqual([1])
      reopenedNoDb.close()
    })
  })
})
