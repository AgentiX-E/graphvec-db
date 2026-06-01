/**
 * fulltext.spec.ts — FullTextIndex 主测试 + save/load 持久化测试
 *
 * 测试点：
 * - 1. 基础索引与搜索
 * - 2. save/load 持久化完整轮转
 * - 3. 空索引持久化
 * - 4. 不存在目录的 load
 * - 5. 损坏文件的恢复
 * - 6. 原子写入安全
 */
import { FullTextIndex } from './fulltext'
import * as fs from 'fs'
import * as path from 'path'

function tmpDir(): string {
  const dir = path.join('/tmp', `fulltext-persist-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

describe('FullTextIndex Persistence', () => {
  describe('save / load round-trip', () => {
    test('should persist documents and restore them correctly', () => {
      const dir = tmpDir()
      try {
        const idx = new FullTextIndex()
        idx.addDocument('doc1', { name: 'hello world' })
        idx.addDocument('doc2', { name: 'foo bar' })
        idx.addDocument('doc3', { name: 'hello foo' })
        idx.save(dir)

        // Verify file exists
        const filePath = path.join(dir, 'fulltext-index.json')
        expect(fs.existsSync(filePath)).toBe(true)

        // Load into a fresh index
        const idx2 = new FullTextIndex()
        idx2.load(dir)

        expect(idx2.count()).toBe(3)

        const helloResults = idx2.search('hello')
        expect(helloResults).toHaveLength(2)
        const docIds = helloResults.map(r => r.docId)
        expect(docIds).toContain('doc1')
        expect(docIds).toContain('doc3')

        const fooResults = idx2.search('foo')
        expect(fooResults).toHaveLength(2)

        const barResults = idx2.search('bar')
        expect(barResults).toHaveLength(1)
        expect(barResults[0].docId).toBe('doc2')
      } finally {
        cleanup(dir)
      }
    })

    test('save + add more + save should reflect all documents', () => {
      const dir = tmpDir()
      try {
        const idx = new FullTextIndex()
        idx.addDocument('doc1', { name: 'first' })
        idx.save(dir)

        // Add more after first save
        idx.addDocument('doc2', { name: 'second' })
        idx.save(dir)

        const idx2 = new FullTextIndex()
        idx2.load(dir)

        expect(idx2.count()).toBe(2)
        expect(idx2.search('first')).toHaveLength(1)
        expect(idx2.search('second')).toHaveLength(1)
      } finally {
        cleanup(dir)
      }
    })

    test('should persist multi-field documents correctly', () => {
      const dir = tmpDir()
      try {
        const idx = new FullTextIndex({
          fieldWeights: { title: 2.0, content: 1.0, tags: 1.5 },
        })
        idx.addDocument('doc1', { title: 'Graph Theory', content: 'Study of graphs', tags: 'math' })
        idx.addDocument('doc2', { title: 'Database Systems', content: 'Relational databases', tags: 'computer' })
        idx.save(dir)

        const idx2 = new FullTextIndex({
          fieldWeights: { title: 2.0, content: 1.0, tags: 1.5 },
        })
        idx2.load(dir)

        expect(idx2.search('Graph')).toHaveLength(1)
        expect(idx2.search('database')).toHaveLength(1)
        expect(idx2.search('Study')).toHaveLength(1)
      } finally {
        cleanup(dir)
      }
    })

    test('should persist CJK text with cjk analyzer', () => {
      const dir = tmpDir()
      try {
        const idx = new FullTextIndex({ analyzer: 'cjk' })
        idx.addDocument('doc1', { name: '我喜欢编程' })
        idx.addDocument('doc2', { name: 'Python编程guide' })
        idx.save(dir)

        const idx2 = new FullTextIndex({ analyzer: 'cjk' })
        idx2.load(dir)

        expect(idx2.count()).toBe(2)
        expect(idx2.search('编程')).toHaveLength(2)
        expect(idx2.search('guide')).toHaveLength(1)
      } finally {
        cleanup(dir)
      }
    })
  })

  describe('load on empty directory', () => {
    test('should not crash when directory does not exist', () => {
      const idx = new FullTextIndex()
      // Should not throw
      idx.load('/nonexistent/path')
      expect(idx.count()).toBe(0)
    })

    test('should not crash when save dir has no index file', () => {
      const dir = tmpDir()
      try {
        fs.mkdirSync(dir, { recursive: true })
        const idx = new FullTextIndex()
        idx.load(dir)
        expect(idx.count()).toBe(0)
      } finally {
        cleanup(dir)
      }
    })

    test('empty index save produces valid file', () => {
      const dir = tmpDir()
      try {
        const idx = new FullTextIndex()
        idx.save(dir)

        const filePath = path.join(dir, 'fulltext-index.json')
        expect(fs.existsSync(filePath)).toBe(true)

        const idx2 = new FullTextIndex()
        idx2.load(dir)
        expect(idx2.count()).toBe(0)
      } finally {
        cleanup(dir)
      }
    })
  })

  describe('corrupt file recovery', () => {
    test('should gracefully recover from corrupt JSON', () => {
      const dir = tmpDir()
      try {
        const filePath = path.join(dir, 'fulltext-index.json')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(filePath, 'this is not valid json', 'utf-8')

        const idx = new FullTextIndex()
        idx.load(dir)
        expect(idx.count()).toBe(0)
      } finally {
        cleanup(dir)
      }
    })

    test('should gracefully recover from partial JSON', () => {
      const dir = tmpDir()
      try {
        const filePath = path.join(dir, 'fulltext-index.json')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(filePath, '{"version": 1, "storedFields": {', 'utf-8')

        const idx = new FullTextIndex()
        idx.load(dir)
        expect(idx.count()).toBe(0)
      } finally {
        cleanup(dir)
      }
    })
  })

  describe('atomic write safety', () => {
    test('should not leave .tmp file after save', () => {
      const dir = tmpDir()
      try {
        const idx = new FullTextIndex()
        idx.addDocument('doc1', { name: 'test' })
        idx.save(dir)

        const tmpFile = path.join(dir, 'fulltext-index.json.tmp')
        expect(fs.existsSync(tmpFile)).toBe(false)
        expect(fs.existsSync(path.join(dir, 'fulltext-index.json'))).toBe(true)
      } finally {
        cleanup(dir)
      }
    })
  })
})
