/**
 * columnar-index.spec.ts — ColumnarIndex 单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ColumnarIndex, parseKey } from './columnar-index'

const TEST_DIR = path.join(os.tmpdir(), `col-index-test-${Date.now()}`)

function makeConfig(columns: string[] = ['age', 'name', 'score']) {
  return {
    enable: true,
    columns,
    indexPath: path.join(TEST_DIR, 'idx'),
    syncOnWrite: true,
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
})
