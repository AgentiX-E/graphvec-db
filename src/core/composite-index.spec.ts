// ============================================================
// Composite Index — 复合索引功能测试
//
// 测试目标：
// 1. OverGraphStorage 的 createCompositeIndex / dropCompositeIndex
// 2. _addToCompositeIndex / _removeFromCompositeIndex
// 3. _findByCompositeIndex 前缀匹配
// 4. 唯一约束
// 5. upsertNode 自动更新索引
// 6. 无匹配索引时回退
// ============================================================

import {
  OverGraphStorage,
  CompositeIndexDef,
} from './overgraph-storage'

// 使用纯内存测试（不依赖 OverGraph 数据库）
// 直接测试复合索引的逻辑层

describe('Composite Index — 纯逻辑层（不依赖 OverGraph DB）', () => {
  // 创建一个轻量测试用的 OverGraphStorage 实例
  // 注意：我们直接测试 _compositeIndexes 的操作方法
  let storage: OverGraphStorage

  beforeEach(() => {
    storage = new OverGraphStorage()
  })

  afterEach(() => {
    storage.close()
  })

  // ──────────────────────────────────────────
  // createCompositeIndex / dropCompositeIndex
  // ──────────────────────────────────────────

  test('G2-1: createCompositeIndex should store index definition', () => {
    storage.createCompositeIndex(['typeId', 'name'], 'idx_type_name')
    const indexes = (storage as any)._compositeIndexes as Map<string, CompositeIndexDef>
    expect(indexes.has('idx_type_name')).toBe(true)
    const def = indexes.get('idx_type_name')!
    expect(def.fields).toEqual(['typeId', 'name'])
    expect(def.unique).toBe(false)
    expect(def.data).toBeInstanceOf(Map)
  })

  test('G2-2: createCompositeIndex with unique option', () => {
    storage.createCompositeIndex(['email'], 'idx_email_unique', { unique: true })
    const indexes = (storage as any)._compositeIndexes as Map<string, CompositeIndexDef>
    const def = indexes.get('idx_email_unique')!
    expect(def.unique).toBe(true)
    expect(def.fields).toEqual(['email'])
  })

  test('G2-3: createCompositeIndex same name twice is idempotent', () => {
    storage.createCompositeIndex(['a'], 'idx')
    storage.createCompositeIndex(['b'], 'idx') // same name, different fields
    const indexes = (storage as any)._compositeIndexes as Map<string, CompositeIndexDef>
    expect(indexes.size).toBe(1)
    // first definition wins
    const def = indexes.get('idx')!
    expect(def.fields).toEqual(['a'])
  })

  test('G2-4: dropCompositeIndex removes the index', () => {
    storage.createCompositeIndex(['typeId'], 'idx_type')
    expect((storage as any)._compositeIndexes.has('idx_type')).toBe(true)
    storage.dropCompositeIndex('idx_type')
    expect((storage as any)._compositeIndexes.has('idx_type')).toBe(false)
  })

  test('G2-5: dropCompositeIndex on non-existent index is no-op', () => {
    expect(() => storage.dropCompositeIndex('nonexistent')).not.toThrow()
  })

  // ──────────────────────────────────────────
  // _addToCompositeIndex / _removeFromCompositeIndex
  // ──────────────────────────────────────────

  test('G2-6: _addToCompositeIndex should add node to index', () => {
    storage.createCompositeIndex(['typeId', 'status'], 'idx_type_status')
    const values = { typeId: 5, status: 'active' }
    ;(storage as any)._addToCompositeIndex('idx_type_status', values, 101)

    const def = ((storage as any)._compositeIndexes as Map<string, CompositeIndexDef>).get('idx_type_status')!
    const key = '5|active' // typeId=5, status=active, sorted and joined by '|'
    expect(def.data.has(key)).toBe(true)
    expect(def.data.get(key)).toEqual([101])
  })

  test('G2-7: _addToCompositeIndex should append to existing key', () => {
    storage.createCompositeIndex(['typeId', 'status'], 'idx')
    const values = { typeId: 5, status: 'active' }
    ;(storage as any)._addToCompositeIndex('idx', values, 101)
    ;(storage as any)._addToCompositeIndex('idx', values, 102)

    const def = ((storage as any)._compositeIndexes as Map<string, CompositeIndexDef>).get('idx')!
    const key = '5|active'
    expect(def.data.get(key)!.sort()).toEqual([101, 102])
  })

  test('G2-8: _removeFromCompositeIndex should remove node from index', () => {
    storage.createCompositeIndex(['typeId', 'status'], 'idx')
    const values = { typeId: 5, status: 'active' }
    ;(storage as any)._addToCompositeIndex('idx', values, 101)
    ;(storage as any)._addToCompositeIndex('idx', values, 102)
    ;(storage as any)._removeFromCompositeIndex('idx', 101)

    const def = ((storage as any)._compositeIndexes as Map<string, CompositeIndexDef>).get('idx')!
    const key = '5|active'
    expect(def.data.get(key)!).toEqual([102])
  })

  test('G2-9: _removeFromCompositeIndex last node removes key', () => {
    storage.createCompositeIndex(['typeId', 'status'], 'idx')
    const values = { typeId: 5, status: 'active' }
    ;(storage as any)._addToCompositeIndex('idx', values, 101)
    ;(storage as any)._removeFromCompositeIndex('idx', 101)

    const def = ((storage as any)._compositeIndexes as Map<string, CompositeIndexDef>).get('idx')!
    const key = '5|active'
    expect(def.data.has(key)).toBe(false)
  })

  // ──────────────────────────────────────────
  // 唯一约束
  // ──────────────────────────────────────────

  test('G2-10: unique constraint violation should throw', () => {
    storage.createCompositeIndex(['email'], 'idx_email', { unique: true })
    ;(storage as any)._addToCompositeIndex('idx_email', { email: 'alice@test.com' }, 101)

    // 同一个邮箱给不同节点 → 应抛出
    expect(() => {
      ;(storage as any)._addToCompositeIndex('idx_email', { email: 'alice@test.com' }, 102)
    }).toThrow(/Unique constraint violation/)
  })

  test('G2-11: unique constraint same node idempotent', () => {
    storage.createCompositeIndex(['email'], 'idx_email', { unique: true })
    ;(storage as any)._addToCompositeIndex('idx_email', { email: 'alice@test.com' }, 101)
    // 同一个节点再次添加 → 不应抛出
    expect(() => {
      ;(storage as any)._addToCompositeIndex('idx_email', { email: 'alice@test.com' }, 101)
    }).not.toThrow()
  })

  test('G2-12: unique constraint on multi-field index', () => {
    storage.createCompositeIndex(['typeId', 'name'], 'idx_unique', { unique: true })
    ;(storage as any)._addToCompositeIndex('idx_unique', { typeId: 1, name: 'alice' }, 101)
    // 相同复合键 → 应抛出
    expect(() => {
      ;(storage as any)._addToCompositeIndex('idx_unique', { typeId: 1, name: 'alice' }, 102)
    }).toThrow(/Unique constraint violation/)
    // 不同复合键 → 应允许
    expect(() => {
      ;(storage as any)._addToCompositeIndex('idx_unique', { typeId: 1, name: 'bob' }, 103)
    }).not.toThrow()
  })

  // ──────────────────────────────────────────
  // _findByCompositeIndex
  // ──────────────────────────────────────────

  test('G2-13: _findByCompositeIndex exact match returns nodes', () => {
    storage.createCompositeIndex(['typeId', 'status'], 'idx')
    ;(storage as any)._addToCompositeIndex('idx', { typeId: 5, status: 'active' }, 101)
    ;(storage as any)._addToCompositeIndex('idx', { typeId: 5, status: 'inactive' }, 102)
    ;(storage as any)._addToCompositeIndex('idx', { typeId: 3, status: 'active' }, 103)

    const result = (storage as any)._findByCompositeIndex(
      ['typeId', 'status'],
      { typeId: 5, status: 'active' },
    )
    expect(result).toEqual([101])
  })

  test('G2-14: _findByCompositeIndex prefix match (first field only)', () => {
    storage.createCompositeIndex(['typeId', 'status'], 'idx')
    ;(storage as any)._addToCompositeIndex('idx', { typeId: 5, status: 'active' }, 101)
    ;(storage as any)._addToCompositeIndex('idx', { typeId: 5, status: 'inactive' }, 102)
    ;(storage as any)._addToCompositeIndex('idx', { typeId: 3, status: 'active' }, 103)

    const result = (storage as any)._findByCompositeIndex(
      ['typeId'],
      { typeId: 5 },
    )
    // 前缀匹配：typeId=5 → 应返回 [101, 102]
    expect(result).toBeDefined()
    if (result) {
      expect(result.sort()).toEqual([101, 102])
    }
  })

  test('G2-15: _findByCompositeIndex no matching index returns null', () => {
    storage.createCompositeIndex(['typeId', 'status'], 'idx')

    // 查询不存在的字段组合
    const result = (storage as any)._findByCompositeIndex(
      ['name'],
      { name: 'alice' },
    )
    expect(result).toBeNull()
  })

  test('G2-16: _findByCompositeIndex no results returns empty array', () => {
    storage.createCompositeIndex(['typeId', 'status'], 'idx')
    ;(storage as any)._addToCompositeIndex('idx', { typeId: 5, status: 'active' }, 101)

    const result = (storage as any)._findByCompositeIndex(
      ['typeId', 'status'],
      { typeId: 99, status: 'nonexistent' },
    )
    expect(result).toEqual([])
  })

  test('G2-17: _findByCompositeIndex with 3-field index prefix match', () => {
    storage.createCompositeIndex(['a', 'b', 'c'], 'idx_abc')
    ;(storage as any)._addToCompositeIndex('idx_abc', { a: 1, b: 'x', c: true }, 10)
    ;(storage as any)._addToCompositeIndex('idx_abc', { a: 1, b: 'y', c: false }, 11)
    ;(storage as any)._addToCompositeIndex('idx_abc', { a: 2, b: 'x', c: true }, 12)

    // 前缀匹配：a=1 → 应返回 [10, 11]
    const result = (storage as any)._findByCompositeIndex(['a'], { a: 1 })
    expect(result).toBeDefined()
    if (result) {
      expect(result.sort()).toEqual([10, 11])
    }

    // 前缀匹配：a=1, b=x → 应返回 [10]
    const result2 = (storage as any)._findByCompositeIndex(
      ['a', 'b'],
      { a: 1, b: 'x' },
    )
    expect(result2).toEqual([10])
  })

  // ──────────────────────────────────────────
  // _updateCompositeIndex
  // ──────────────────────────────────────────

  test('G2-18: _updateCompositeIndex adds node to all matching indexes', () => {
    storage.createCompositeIndex(['typeId', 'status'], 'idx1')
    storage.createCompositeIndex(['region'], 'idx2')

    ;(storage as any)._updateCompositeIndex(5, 101, { typeId: 5, status: 'active', region: 'us-east' })

    // idx1: typeId=5, status=active
    const idx1 = ((storage as any)._compositeIndexes as Map<string, CompositeIndexDef>).get('idx1')!
    expect(idx1.data.get('5|active')).toEqual([101])

    // idx2: region=us-east
    const idx2 = ((storage as any)._compositeIndexes as Map<string, CompositeIndexDef>).get('idx2')!
    expect(idx2.data.get('us-east')).toEqual([101])
  })

  test('G2-19: _updateCompositeIndex removes old key and adds new key on update', () => {
    storage.createCompositeIndex(['status'], 'idx_status')
    ;(storage as any)._updateCompositeIndex(5, 101, { status: 'active' })

    // 初始为 active
    let def = ((storage as any)._compositeIndexes as Map<string, CompositeIndexDef>).get('idx_status')!
    expect(def.data.get('active')).toEqual([101])

    // 更新为 inactive
    ;(storage as any)._updateCompositeIndex(5, 101, { status: 'inactive' })
    def = ((storage as any)._compositeIndexes as Map<string, CompositeIndexDef>).get('idx_status')!

    // 旧键应被移除
    expect(def.data.has('active')).toBe(false)
    // 新键应存在
    expect(def.data.get('inactive')).toEqual([101])
  })

  test('G2-20: _updateCompositeIndex skips nodes missing indexed fields', () => {
    storage.createCompositeIndex(['email'], 'idx_email')

    // props 中没有 email 字段，不应加入索引
    ;(storage as any)._updateCompositeIndex(5, 101, { name: 'alice' })

    const def = ((storage as any)._compositeIndexes as Map<string, CompositeIndexDef>).get('idx_email')!
    expect(def.data.size).toBe(0)
  })
})
