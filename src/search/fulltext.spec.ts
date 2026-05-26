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

  describe('CJK 分词支持 (Item 19)', () => {
    test('TC-19.1: 中文搜索 — 索引"我喜欢编程"并搜索"编程"应匹配', () => {
      const idx = new FullTextIndex()
      idx.addDocument('doc1', { name: '我喜欢编程' })
      const results = idx.search('编程')
      expect(results).toHaveLength(1)
      expect(results[0].docId).toBe('doc1')
    })

    test('TC-19.2: 日语搜索 — 索引"私はコードが好きです"并搜索"コード"应匹配', () => {
      const idx = new FullTextIndex()
      idx.addDocument('doc1', { name: '私はコードが好きです' })
      const results = idx.search('コード')
      expect(results).toHaveLength(1)
      expect(results[0].docId).toBe('doc1')
    })

    test('TC-19.3: 混合中英文 — 索引"Python编程guide"并搜索"编程guide"应匹配', () => {
      const idx = new FullTextIndex()
      idx.addDocument('doc1', { name: 'Python编程guide' })
      const results = idx.search('编程guide')
      expect(results).toHaveLength(1)
      expect(results[0].docId).toBe('doc1')
    })

    test('TC-19.4: 无CJK文本 — 纯英文搜索不受影响', () => {
      const idx = new FullTextIndex()
      idx.addDocument('doc1', { name: 'hello world' })
      idx.addDocument('doc2', { name: 'foo bar' })
      const results = idx.search('hello')
      expect(results).toHaveLength(1)
      expect(results[0].docId).toBe('doc1')
    })

    test('TC-19.5: 分词边界 — "南京市长江大桥"的正确保留', () => {
      const idx = new FullTextIndex()
      idx.addDocument('doc1', { name: '南京市长江大桥' })
      // 搜索完整短语
      const fullResults = idx.search('南京市')
      expect(fullResults).toHaveLength(1)

      // 搜索"长江"
      const chienResults = idx.search('长江')
      expect(chienResults).toHaveLength(1)

      // 搜索"大桥"
      const bridgeResults = idx.search('大桥')
      expect(bridgeResults).toHaveLength(1)
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
