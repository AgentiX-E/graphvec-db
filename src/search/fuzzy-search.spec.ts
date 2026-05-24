import { FullTextIndex } from './fulltext'

describe('Fuzzy/Prefix/Wildcard Search', () => {
  let idx: FullTextIndex

  beforeEach(() => {
    idx = new FullTextIndex()
    idx.addDocument('doc1', { title: 'hello world', content: 'this is a test document' })
    idx.addDocument('doc2', { title: 'helpful guide', content: 'how to build a graph database' })
    idx.addDocument('doc3', { title: 'graph theory', content: 'hello to the depth of graph algorithms' })
    idx.addDocument('doc4', { title: 'hello again', content: 'deep dive into graph vectors' })
  })

  describe('prefixSearch', () => {
    test('should find terms with given prefix', () => {
      const terms = idx.prefixSearch('hel')
      expect(terms.length).toBeGreaterThanOrEqual(1)
      expect(terms.some(t => t.startsWith('hel'))).toBe(true)
    })

    test('should return empty for unmatched prefix', () => {
      const terms = idx.prefixSearch('zzz')
      expect(terms).toEqual([])
    })

    test('should be case-insensitive', () => {
      const terms = idx.prefixSearch('HEL')
      expect(terms.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('wildcardSearch', () => {
    test('should match with asterisk', () => {
      const terms = idx.wildcardSearch('hel*')
      expect(terms.length).toBeGreaterThanOrEqual(2) // hello, helpful...
    })

    test('should match with single char wildcard', () => {
      const terms = idx.wildcardSearch('hell?')
      expect(terms.some(t => t === 'hello')).toBe(true)
    })

    test('should return empty for unmatchable pattern', () => {
      const terms = idx.wildcardSearch('xy*z')
      expect(terms).toEqual([])
    })
  })

  describe('fuzzy search', () => {
    test('should find docs with fuzzy matching via search', () => {
      // 直接用 BM25 search 的 fuzzy 选项
      const results = idx.search('helo', { fuzzy: true })
      expect(results.length).toBeGreaterThanOrEqual(1)
    })

    test('should find no results without fuzzy for misspelling', () => {
      const results = idx.search('helo', { fuzzy: false })
      expect(results.length).toBe(0)
    })
  })
})
