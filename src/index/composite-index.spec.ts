import { CompositeIndex, IndexRecord, QueryCondition } from './composite-index'

describe('CompositeIndex', () => {
  let index: CompositeIndex

  beforeEach(() => {
    index = new CompositeIndex('test-index')
  })

  afterEach(() => {
    index.clear()
  })

  // ──────────────────────────────────────────
  // 创建与基础属性
  // ──────────────────────────────────────────

  test('should create CompositeIndex with name', () => {
    const idx = new CompositeIndex('my-idx')
    expect(idx).toBeDefined()
    expect(idx.name).toBe('my-idx')
    expect(idx.indexName()).toBe('my-idx')
    expect(idx.size).toBe(0)
  })

  test('should have zero size initially', () => {
    expect(index.size).toBe(0)
  })

  test('stats should reflect empty state', () => {
    const s = index.stats()
    expect(s.name).toBe('test-index')
    expect(s.recordCount).toBe(0)
    expect(s.fieldKeys).toEqual([])
  })

  // ──────────────────────────────────────────
  // addRecord
  // ──────────────────────────────────────────

  test('should add a record and increase size', () => {
    index.addRecord({ id: '1', fields: { name: 'Alice', age: 30 } })
    expect(index.size).toBe(1)
  })

  test('should add multiple records', () => {
    index.addRecord({ id: '1', fields: { name: 'Alice' } })
    index.addRecord({ id: '2', fields: { name: 'Bob' } })
    index.addRecord({ id: '3', fields: { name: 'Charlie' } })
    expect(index.size).toBe(3)
  })

  test('should overwrite record with same id', () => {
    index.addRecord({ id: '1', fields: { name: 'Alice', age: 30 } })
    index.addRecord({ id: '1', fields: { name: 'Alice Updated', age: 31 } })
    expect(index.size).toBe(1)
    const results = index.queryExact('name', 'Alice Updated')
    expect(results).toHaveLength(1)
  })

  test('should handle boolean field values', () => {
    index.addRecord({ id: '1', fields: { active: true, verified: false } })
    expect(index.queryExact('active', true)).toHaveLength(1)
    expect(index.queryExact('verified', true)).toHaveLength(0)
    expect(index.queryExact('verified', false)).toHaveLength(1)
  })

  test('should handle string field values', () => {
    index.addRecord({ id: '1', fields: { tag: 'important' } })
    expect(index.queryExact('tag', 'important')).toHaveLength(1)
    expect(index.queryExact('tag', 'not-there')).toHaveLength(0)
  })

  // ──────────────────────────────────────────
  // removeRecord
  // ──────────────────────────────────────────

  test('should remove a record', () => {
    index.addRecord({ id: '1', fields: { name: 'Alice' } })
    const removed = index.removeRecord('1')
    expect(removed).toBe(true)
    expect(index.size).toBe(0)
  })

  test('should return false when removing non-existent record', () => {
    const removed = index.removeRecord('non-existent')
    expect(removed).toBe(false)
  })

  test('should remove record and not affect others', () => {
    index.addRecord({ id: '1', fields: { name: 'Alice' } })
    index.addRecord({ id: '2', fields: { name: 'Bob' } })
    index.removeRecord('1')
    expect(index.size).toBe(1)
    expect(index.queryExact('name', 'Bob')).toHaveLength(1)
  })

  test('should remove record with numeric fields', () => {
    index.addRecord({ id: '1', fields: { score: 100 } })
    index.addRecord({ id: '2', fields: { score: 200 } })
    index.removeRecord('1')
    expect(index.queryExact('score', 100)).toHaveLength(0)
    expect(index.queryExact('score', 200)).toHaveLength(1)
  })

  // ──────────────────────────────────────────
  // queryExact
  // ──────────────────────────────────────────

  test('should find record by exact string match', () => {
    index.addRecord({ id: '1', fields: { name: 'Alice' } })
    const results = index.queryExact('name', 'Alice')
    expect(results).toEqual(['1'])
  })

  test('should return empty for exact match on non-indexed field', () => {
    index.addRecord({ id: '1', fields: { name: 'Alice' } })
    const results = index.queryExact('unknown', 'value')
    expect(results).toEqual([])
  })

  test('should find record by exact numeric match', () => {
    index.addRecord({ id: '1', fields: { age: 30 } })
    const results = index.queryExact('age', 30)
    expect(results).toEqual(['1'])
  })

  test('should find multiple records by exact match', () => {
    index.addRecord({ id: '1', fields: { city: 'NYC' } })
    index.addRecord({ id: '2', fields: { city: 'NYC' } })
    index.addRecord({ id: '3', fields: { city: 'LA' } })
    const results = index.queryExact('city', 'NYC')
    expect(results).toHaveLength(2)
    expect(results).toContain('1')
    expect(results).toContain('2')
  })

  test('should find record by boolean exact match', () => {
    index.addRecord({ id: '1', fields: { active: true } })
    const results = index.queryExact('active', true)
    expect(results).toEqual(['1'])
  })

  // ──────────────────────────────────────────
  // queryRange
  // ──────────────────────────────────────────

  test('should query range with both min and max', () => {
    index.addRecord({ id: '1', fields: { score: 10 } })
    index.addRecord({ id: '2', fields: { score: 20 } })
    index.addRecord({ id: '3', fields: { score: 30 } })
    const results = index.queryRange('score', 15, 25)
    expect(results).toEqual(['2'])
  })

  test('should query range with only min', () => {
    index.addRecord({ id: '1', fields: { score: 10 } })
    index.addRecord({ id: '2', fields: { score: 20 } })
    index.addRecord({ id: '3', fields: { score: 30 } })
    const results = index.queryRange('score', 20)
    expect(results).toHaveLength(2)
    expect(results).toContain('2')
    expect(results).toContain('3')
  })

  test('should query range with only max', () => {
    index.addRecord({ id: '1', fields: { score: 10 } })
    index.addRecord({ id: '2', fields: { score: 20 } })
    index.addRecord({ id: '3', fields: { score: 30 } })
    const results = index.queryRange('score', undefined, 20)
    expect(results).toHaveLength(2)
    expect(results).toContain('1')
    expect(results).toContain('2')
  })

  test('should return empty for range on non-numeric field', () => {
    index.addRecord({ id: '1', fields: { name: 'Alice' } })
    const results = index.queryRange('name', 1, 10)
    expect(results).toEqual([])
  })

  test('should return empty for range on non-indexed field', () => {
    const results = index.queryRange('missing', 0, 10)
    expect(results).toEqual([])
  })

  test('should handle empty range with no records', () => {
    const results = index.queryRange('score', 0, 100)
    expect(results).toEqual([])
  })

  // ──────────────────────────────────────────
  // queryPrefix
  // ──────────────────────────────────────────

  test('should find records by prefix', () => {
    index.addRecord({ id: '1', fields: { name: 'apple' } })
    index.addRecord({ id: '2', fields: { name: 'application' } })
    index.addRecord({ id: '3', fields: { name: 'banana' } })
    const results = index.queryPrefix('name', 'app')
    expect(results).toHaveLength(2)
    expect(results).toContain('1')
    expect(results).toContain('2')
  })

  test('should return empty for prefix that does not match', () => {
    index.addRecord({ id: '1', fields: { name: 'apple' } })
    const results = index.queryPrefix('name', 'xyz')
    expect(results).toEqual([])
  })

  test('should return empty for prefix on non-indexed field', () => {
    const results = index.queryPrefix('missing', 'pre')
    expect(results).toEqual([])
  })

  test('should handle prefix with numeric field (treated as string)', () => {
    index.addRecord({ id: '1', fields: { code: 12345 } })
    // Numeric values are stored in numericIndex, not fieldIndex, so prefix won't work
    const results = index.queryPrefix('code', '12')
    expect(results).toEqual([])
  })

  // ──────────────────────────────────────────
  // 跨字段复合查询 (query with multiple conditions)
  // ──────────────────────────────────────────

  test('should query with single eq condition', () => {
    index.addRecord({ id: '1', fields: { name: 'Alice', city: 'NYC' } })
    index.addRecord({ id: '2', fields: { name: 'Bob', city: 'NYC' } })
    const conditions: QueryCondition[] = [
      { field: 'city', operator: 'eq', value: 'NYC' },
    ]
    const results = index.query(conditions)
    expect(results).toHaveLength(2)
  })

  test('should query with AND of two eq conditions (cross-field)', () => {
    index.addRecord({ id: '1', fields: { name: 'Alice', city: 'NYC', age: 30 } })
    index.addRecord({ id: '2', fields: { name: 'Bob', city: 'NYC', age: 25 } })
    index.addRecord({ id: '3', fields: { name: 'Alice', city: 'LA', age: 35 } })

    const conditions: QueryCondition[] = [
      { field: 'name', operator: 'eq', value: 'Alice' },
      { field: 'city', operator: 'eq', value: 'NYC' },
    ]
    const results = index.query(conditions)
    expect(results).toEqual(['1'])
  })

  test('should query with eq + range conditions', () => {
    index.addRecord({ id: '1', fields: { name: 'Alice', age: 30 } })
    index.addRecord({ id: '2', fields: { name: 'Bob', age: 40 } })
    index.addRecord({ id: '3', fields: { name: 'Alice', age: 50 } })

    const conditions: QueryCondition[] = [
      { field: 'name', operator: 'eq', value: 'Alice' },
      { field: 'age', operator: 'gte', value: 25 },
    ]
    const results = index.query(conditions)
    expect(results).toHaveLength(2)
    expect(results).toContain('1')
    expect(results).toContain('3')
  })

  test('should query with eq + prefix conditions', () => {
    index.addRecord({ id: '1', fields: { name: 'apple', category: 'fruit' } })
    index.addRecord({ id: '2', fields: { name: 'application', category: 'software' } })
    index.addRecord({ id: '3', fields: { name: 'apricot', category: 'fruit' } })

    const conditions: QueryCondition[] = [
      { field: 'category', operator: 'eq', value: 'fruit' },
      { field: 'name', operator: 'prefix', value: 'app' },
    ]
    const results = index.query(conditions)
    expect(results).toHaveLength(1)
    expect(results).toContain('1')
  })

  test('should return empty when no records match all conditions', () => {
    index.addRecord({ id: '1', fields: { name: 'Alice', age: 30 } })
    const conditions: QueryCondition[] = [
      { field: 'name', operator: 'eq', value: 'Alice' },
      { field: 'age', operator: 'gte', value: 100 },
    ]
    const results = index.query(conditions)
    expect(results).toEqual([])
  })

  test('should return all records with empty conditions', () => {
    index.addRecord({ id: '1', fields: { name: 'Alice' } })
    index.addRecord({ id: '2', fields: { name: 'Bob' } })
    const results = index.query([])
    expect(results).toHaveLength(2)
    expect(results).toContain('1')
    expect(results).toContain('2')
  })

  test('should handle gt operator in query', () => {
    index.addRecord({ id: '1', fields: { score: 10 } })
    index.addRecord({ id: '2', fields: { score: 20 } })
    index.addRecord({ id: '3', fields: { score: 30 } })
    const results = index.query([{ field: 'score', operator: 'gt', value: 20 }])
    expect(results).toEqual(['3'])
  })

  test('should handle gte operator in query', () => {
    index.addRecord({ id: '1', fields: { score: 10 } })
    index.addRecord({ id: '2', fields: { score: 20 } })
    index.addRecord({ id: '3', fields: { score: 30 } })
    const results = index.query([{ field: 'score', operator: 'gte', value: 20 }])
    expect(results).toHaveLength(2)
    expect(results).toContain('2')
    expect(results).toContain('3')
  })

  test('should handle lt operator in query', () => {
    index.addRecord({ id: '1', fields: { score: 10 } })
    index.addRecord({ id: '2', fields: { score: 20 } })
    index.addRecord({ id: '3', fields: { score: 30 } })
    const results = index.query([{ field: 'score', operator: 'lt', value: 20 }])
    expect(results).toEqual(['1'])
  })

  test('should handle lte operator in query', () => {
    index.addRecord({ id: '1', fields: { score: 10 } })
    index.addRecord({ id: '2', fields: { score: 20 } })
    index.addRecord({ id: '3', fields: { score: 30 } })
    const results = index.query([{ field: 'score', operator: 'lte', value: 20 }])
    expect(results).toHaveLength(2)
    expect(results).toContain('1')
    expect(results).toContain('2')
  })

  test('should handle multiple numeric range conditions AND-ed', () => {
    index.addRecord({ id: '1', fields: { min: 5, max: 15 } })
    index.addRecord({ id: '2', fields: { min: 10, max: 20 } })
    index.addRecord({ id: '3', fields: { min: 3, max: 8 } })

    const conditions: QueryCondition[] = [
      { field: 'min', operator: 'gte', value: 5 },
      { field: 'max', operator: 'lte', value: 15 },
    ]
    const results = index.query(conditions)
    expect(results).toHaveLength(1)
    expect(results).toContain('1')
  })

  // ──────────────────────────────────────────
  // clear
  // ──────────────────────────────────────────

  test('clear should remove all records', () => {
    index.addRecord({ id: '1', fields: { name: 'Alice' } })
    index.addRecord({ id: '2', fields: { name: 'Bob' } })
    index.clear()
    expect(index.size).toBe(0)
    expect(index.queryExact('name', 'Alice')).toEqual([])
  })

  test('should work after clear (reusable)', () => {
    index.addRecord({ id: '1', fields: { name: 'Alice' } })
    index.clear()
    index.addRecord({ id: '2', fields: { name: 'Bob' } })
    expect(index.size).toBe(1)
    expect(index.queryExact('name', 'Bob')).toEqual(['2'])
  })

  // ──────────────────────────────────────────
  // stats
  // ──────────────────────────────────────────

  test('stats should report correct name and count', () => {
    index.addRecord({ id: '1', fields: { a: 'x', b: 1 } })
    index.addRecord({ id: '2', fields: { a: 'y', c: true } })
    const s = index.stats()
    expect(s.name).toBe('test-index')
    expect(s.recordCount).toBe(2)
    expect(s.fieldKeys).toContain('a')
    expect(s.fieldKeys).toContain('b')
    expect(s.fieldKeys).toContain('c')
  })

  // ──────────────────────────────────────────
  // indexName
  // ──────────────────────────────────────────

  test('indexName should return constructor name', () => {
    expect(index.indexName()).toBe('test-index')
    const idx2 = new CompositeIndex('other')
    expect(idx2.indexName()).toBe('other')
  })
})
