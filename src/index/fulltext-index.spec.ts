// ============================================================
// fulltext-index.spec.ts — FulltextIndex 标签化全文索引测试
// ============================================================

import { describe, it, expect } from 'vitest'
import { FulltextIndex } from './fulltext-index'

describe('FulltextIndex', () => {
  // ── 创建索引后搜索 ──
  it('should index documents and return search results', () => {
    const idx = new FulltextIndex()
    idx.addLabel('documents', ['title', 'content'])

    idx.index('documents', 1, { title: 'Hello World', content: 'This is a test document' })
    idx.index('documents', 2, { title: 'Graph Theory', content: 'Study of graphs and networks' })
    idx.index('documents', 3, { title: 'Machine Learning', content: 'Algorithms that learn from data' })

    const results = idx.search('documents', 'hello')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].id).toBe(1)
    expect(results[0].score).toBeGreaterThan(0)
  })

  // ── 模糊搜索 ──
  it('should support fuzzy search', () => {
    const idx = new FulltextIndex()
    idx.addLabel('docs', ['name'])

    idx.index('docs', 1, { name: 'algorithm' })
    idx.index('docs', 2, { name: 'algebra' })
    idx.index('docs', 3, { name: 'architecture' })

    // 不带 fuzzy 时，严格匹配
    const strictResults = idx.search('docs', 'algoritm', { fuzzy: false })
    expect(strictResults.length).toBe(0)

    // 带 fuzzy 时，容错匹配
    const fuzzyResults = idx.search('docs', 'algoritm', { fuzzy: true })
    expect(fuzzyResults.length).toBeGreaterThan(0)
    // "algorithm" 应该匹配
    const matchedIds = fuzzyResults.map(r => r.id)
    expect(matchedIds).toContain(1)
  })

  // ── 前缀搜索 ──
  it('should support prefix search', () => {
    const idx = new FulltextIndex()
    idx.addLabel('docs', ['name'])

    idx.index('docs', 1, { name: 'Graph Database' })
    idx.index('docs', 2, { name: 'Graph Theory' })
    idx.index('docs', 3, { name: 'Gradient Descent' })

    // 前缀搜索 "gra"
    const prefixResults = idx.search('docs', 'gra', { prefix: true })
    expect(prefixResults.length).toBeGreaterThanOrEqual(2) // "Graph Database" 和 "Graph Theory"
    const matchedIds = prefixResults.map(r => r.id)
    expect(matchedIds).toContain(1)
    expect(matchedIds).toContain(2)

    // 前缀搜索 "gr" — 不匹配 "Gradient"
    const prefixResults2 = idx.search('docs', 'gr', { prefix: true })
    expect(prefixResults2.length).toBeGreaterThanOrEqual(2)
  })

  // ── 跨多字段搜索 ──
  it('should search across multiple fields', () => {
    const idx = new FulltextIndex()
    idx.addLabel('books', ['title', 'author', 'description'])

    idx.index('books', 1, {
      title: 'Introduction to Algorithms',
      author: 'Thomas Cormen',
      description: 'A comprehensive textbook on computer algorithms',
    })
    idx.index('books', 2, {
      title: 'The Art of Computer Programming',
      author: 'Donald Knuth',
      description: 'A classic series on algorithms and data structures',
    })
    idx.index('books', 3, {
      title: 'Clean Code',
      author: 'Robert Martin',
      description: 'A handbook of agile software craftsmanship',
    })

    // 在 author 字段搜索
    const authorResults = idx.search('books', 'Thomas')
    expect(authorResults.length).toBeGreaterThan(0)
    expect(authorResults[0].id).toBe(1)

    // 在 description 字段搜索
    const descResults = idx.search('books', 'software')
    expect(descResults.length).toBeGreaterThan(0)
    expect(descResults[0].id).toBe(3)

    // 跨字段搜索（只搜索 title 和 description 时，"Donald" 在 author 字段）
    // MiniSearch 默认搜索所有注册字段
    const crossResults = idx.search('books', 'algorithms')
    expect(crossResults.length).toBeGreaterThanOrEqual(2) // book 1 和 book 2
    const crossIds = crossResults.map(r => r.id)
    expect(crossIds).toContain(1)
    expect(crossIds).toContain(2)
  })

  // ── 不存在的 label → 空结果 ──
  it('should return empty results for nonexistent label', () => {
    const idx = new FulltextIndex()
    idx.addLabel('users', ['name'])

    const results = idx.search('nonexistent', 'hello')
    expect(results).toEqual([])
  })

  // ── 空文本 → 不报错 ──
  it('should handle empty text gracefully', () => {
    const idx = new FulltextIndex()
    idx.addLabel('docs', ['name'])

    // 索引空文本不应该报错
    expect(() => {
      idx.index('docs', 1, { name: '' })
    }).not.toThrow()

    // 搜索空字符串应返回空数组
    const results = idx.search('docs', '')
    expect(results).toEqual([])

    // 搜索仅包含空白字符的字符串
    const whitespaceResults = idx.search('docs', '   ')
    expect(whitespaceResults).toEqual([])
  })

  // ── rebuildFromEngine 重建 ──
  it('should rebuild from GraphEngine', () => {
    // 模拟一个简单的 GraphEngine
    const mockEngine = {
      getNodeIds: () => [1, 2, 3, 4],
      getNode: (id: number) => {
        const nodes: Record<number, any> = {
          1: { label: 'person', props: { name: 'Alice', description: 'Software engineer' } },
          2: { label: 'person', props: { name: 'Bob', description: 'Data scientist' } },
          3: { label: 'article', props: { title: 'Graph Theory', content: 'Study of graphs' } },
          4: { label: 'article', props: { title: 'Machine Learning', content: 'Learning from data' } },
        }
        return nodes[id] ?? null
      },
    }

    const idx = new FulltextIndex()
    idx.rebuildFromEngine(mockEngine)

    // 验证 labels
    const labels = idx.getLabels()
    expect(labels).toContain('person')
    expect(labels).toContain('article')

    // 验证文档数
    expect(idx.count('person')).toBe(2)
    expect(idx.count('article')).toBe(2)

    // 搜索验证
    const personResults = idx.search('person', 'Alice')
    expect(personResults.length).toBe(1)
    expect(personResults[0].id).toBe(1)

    const articleResults = idx.search('article', 'graphs')
    expect(articleResults.length).toBe(1)
    expect(articleResults[0].id).toBe(3)

    // 跨 label 搜索互不影响
    const articleNoResult = idx.search('article', 'Alice')
    expect(articleNoResult.length).toBe(0)
  })

  it('should handle empty engine in rebuildFromEngine', () => {
    const mockEmptyEngine = {
      getNodeIds: () => [],
      getNode: () => null,
    }

    const idx = new FulltextIndex()
    // 先添加一些数据
    idx.addLabel('test', ['name'])
    idx.index('test', 1, { name: 'hello' })

    // 重建为空引擎
    idx.rebuildFromEngine(mockEmptyEngine)

    expect(idx.getLabels()).toEqual([])
    expect(idx.count('test')).toBe(0)
  })

  it('should handle getLabels correctly', () => {
    const idx = new FulltextIndex()
    expect(idx.getLabels()).toEqual([])

    idx.addLabel('a', ['f1'])
    idx.addLabel('b', ['f2'])

    const labels = idx.getLabels()
    expect(labels).toContain('a')
    expect(labels).toContain('b')
  })
})
