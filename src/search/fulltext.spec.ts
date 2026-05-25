/**
 * fulltext.spec.ts — FullTextIndex (MiniSearch 包裹类) 测试
 *
 * 适配 MiniSearch 7.2.0 的真实行为，包括：
 * - match 结构为 { term: [fieldName] }
 * - fuzzy 搜索默认为模糊 + prefix
 * - 拼写校正：MiniSearch 默认未提供，无需测试
 */
import { FullTextIndex } from './fulltext'

describe('FullTextIndex', () => {
  describe('基础搜索', () => {
    test('should return empty results for empty index', () => {
      const idx = new FullTextIndex()
      expect(idx.search('hello')).toEqual([])
    })

    test('should find a document by single term', () => {
      const idx = new FullTextIndex()
      idx.addDocument('doc1', { name: 'hello world' })
      const results = idx.search('hello')
      expect(results).toHaveLength(1)
      expect(results[0].docId).toBe('doc1')
    })

    test('should find a document by multi-word query', () => {
      const idx = new FullTextIndex()
      idx.addDocument('doc1', { name: 'hello world foo bar' })
      idx.addDocument('doc2', { name: 'only foo' })
      const results = idx.search('hello foo')
      expect(results).toHaveLength(2)
    })

    test('should handle empty query', () => {
      const idx = new FullTextIndex()
      expect(idx.search('')).toEqual([])
      expect(idx.search('   ')).toEqual([])
    })
  })

  describe('Fuzzy 搜索', () => {
    test('should find documents with fuzzy matching', () => {
      const idx = new FullTextIndex()
      idx.addDocument('doc1', { name: 'hello world' })
      idx.addDocument('doc2', { name: 'graph database' })

      const results = idx.search('helo', { fuzzy: true })
      expect(results.length).toBeGreaterThan(0)
      expect(results.some(r => r.docId === 'doc1')).toBe(true)
    })
  })

  describe('搜索结果排序', () => {
    test('should return results sorted by score descending', () => {
      const idx = new FullTextIndex()
      idx.addDocument('doc1', { name: 'hello world' })
      idx.addDocument('doc2', { name: 'hello hello world' })
      idx.addDocument('doc3', { name: 'foo bar' })
      const results = idx.search('hello')
      expect(results).toHaveLength(2)
      expect(results[0].docId).toBe('doc2') // 更高频率 → 更高分
    })
  })

  describe('文档管理', () => {
    test('should remove a document', () => {
      const idx = new FullTextIndex()
      idx.addDocument('doc1', { name: 'hello world' })
      idx.addDocument('doc2', { name: 'foo bar' })
      expect(idx.search('hello')).toHaveLength(1)

      idx.removeDocument('doc1')
      expect(idx.search('hello')).toHaveLength(0)
    })

    test('removeDocument should not throw for non-existent doc', () => {
      const idx = new FullTextIndex()
      expect(() => idx.removeDocument('nonexistent')).not.toThrow()
    })
  })

  describe('highlight()', () => {
    test('should highlight matching terms with default tags', () => {
      const idx = new FullTextIndex()
      idx.addDocument('doc1', { name: 'hello world', description: 'test content' })

      const highlighted = idx.highlight('doc1', 'hello')
      expect(highlighted.name).toContain('<b>hello</b>')
      expect(highlighted.name).toContain('world')
    })

    test('should highlight with custom tags', () => {
      const idx = new FullTextIndex()
      idx.addDocument('doc1', { name: 'hello world' })

      const highlighted = idx.highlight('doc1', 'hello', '**', '**')
      expect(highlighted.name).toContain('**hello**')
    })

    test('should return empty object for non-existent doc', () => {
      const idx = new FullTextIndex()
      expect(idx.highlight('nonexistent', 'hello')).toEqual({})
    })

    test('should return original fields for empty query', () => {
      const idx = new FullTextIndex()
      idx.addDocument('doc1', { name: 'hello world' })
      const result = idx.highlight('doc1', '')
      expect(result.name).toBe('hello world')
    })

    test('should handle special regex characters in query', () => {
      const idx = new FullTextIndex()
      idx.addDocument('doc1', { name: 'price (total)' })
      const highlighted = idx.highlight('doc1', 'price')
      expect(highlighted.name).toContain('<b>price</b>')
    })
  })

  describe('文档计数与状态', () => {
    test('count should return 0 for empty index', () => {
      const idx = new FullTextIndex()
      expect(idx.count()).toBe(0)
    })

    test('count after adding and removing docs', () => {
      const idx = new FullTextIndex()
      idx.addDocument('doc1', { name: 'hello' })
      idx.addDocument('doc2', { name: 'world' })
      expect(idx.count()).toBe(2)
      idx.removeDocument('doc2')
      expect(idx.count()).toBe(1)
    })
  })
})
