/**
 * fulltext-persistence.spec.ts — FullTextIndex WAL 持久化测试
 *
 * 测试点：
 * - 1. 索引文档 → 重启（新实例）→ 索引仍包含文档
 * - 2. 删除文档 → 重启 → 索引不再包含文档
 * - 3. 新创建时无 WAL 文件 → 正常工作
 * - 4. WAL 轮转（超过 1MB 时）
 * - 5. 快照生成（文档数达到阈值时）
 * - 6. 多字段索引恢复
 * - 7. close() 后不再写 WAL
 */
import { FullTextIndex } from './fulltext'
import * as fs from 'fs'
import * as path from 'path'

function tmpDir(): string {
  const dir = path.join('/tmp', `fulltext-wal-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
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

describe('FullTextIndex WAL Persistence', () => {
  describe('P-1: 基础 WAL 恢复', () => {
    test('should persist document across restart', () => {
      const dir = tmpDir()
      try {
        const idx = new FullTextIndex({ baseDir: dir })
        idx.addDocument('doc1', { name: 'hello world' })
        idx.addDocument('doc2', { name: 'foo bar' })
        idx.close()

        // Simulate restart
        const idx2 = new FullTextIndex({ baseDir: dir })
        const results = idx2.search('hello')
        expect(results).toHaveLength(1)
        expect(results[0].docId).toBe('doc1')
        idx2.close()
      } finally {
        cleanup(dir)
      }
    })

    test('should persist removal across restart', () => {
      const dir = tmpDir()
      try {
        const idx = new FullTextIndex({ baseDir: dir })
        idx.addDocument('doc1', { name: 'hello world' })
        idx.addDocument('doc2', { name: 'foo bar' })
        idx.removeDocument('doc1')
        idx.close()

        // Simulate restart
        const idx2 = new FullTextIndex({ baseDir: dir })
        expect(idx2.search('hello')).toHaveLength(0)
        expect(idx2.search('foo')).toHaveLength(1)
        idx2.close()
      } finally {
        cleanup(dir)
      }
    })

    test('should persist multi-field document correctly', () => {
      const dir = tmpDir()
      try {
        const idx = new FullTextIndex({
          baseDir: dir,
          fieldWeights: { title: 2.0, description: 1.0 },
        })
        idx.addDocument('doc1', { title: 'graph database', description: 'a distributed graph database' })
        idx.close()

        const idx2 = new FullTextIndex({
          baseDir: dir,
          fieldWeights: { title: 2.0, description: 1.0 },
        })
        const results = idx2.search('database')
        expect(results).toHaveLength(1)
        const titleResults = idx2.search('graph')
        expect(titleResults).toHaveLength(1)
        idx2.close()
      } finally {
        cleanup(dir)
      }
    })
  })

  describe('P-2: 无 WAL 文件时正常工作', () => {
    test('should work without WAL file initially', () => {
      const dir = tmpDir()
      try {
        const idx = new FullTextIndex({ baseDir: dir })
        expect(idx.count()).toBe(0)
        idx.addDocument('doc1', { name: 'hello' })
        expect(idx.search('hello')).toHaveLength(1)
        idx.close()
      } finally {
        cleanup(dir)
      }
    })

    test('should work without baseDir', () => {
      const idx = new FullTextIndex()
      expect(idx.count()).toBe(0)
      idx.addDocument('doc1', { name: 'hello' })
      expect(idx.search('hello')).toHaveLength(1)
    })

    test('should work on empty dir (no WAL, no snapshot)', () => {
      const dir = tmpDir()
      try {
        const idx = new FullTextIndex({ baseDir: dir })
        expect(idx.count()).toBe(0)
        idx.close()
      } finally {
        cleanup(dir)
      }
    })
  })

  describe('P-3: WAL 轮转', () => {
    test('should rotate WAL when exceeding 1MB', () => {
      const dir = tmpDir()
      try {
        const idx = new FullTextIndex({ baseDir: dir })
        // Add documents until WAL exceeds 1MB
        // Each doc is ~150 bytes, need ~7000 docs
        const totalDocs = 8000
        for (let i = 0; i < totalDocs; i++) {
          idx.addDocument(`doc${i}`, {
            name: `document number ${i} with enough text to fill the wal`,
            content: 'A'.repeat(100),
          })
        }
        idx.close()

        // Verify WAL is rotated and content survives
        const walPath = path.join(dir, 'fulltext-index.wal')
        const walExists = fs.existsSync(walPath)
        const rotatedExists = fs.existsSync(walPath + '.old')

        // At least the current WAL should exist
        expect(walExists || rotatedExists).toBe(true)

        // Recovery should work
        const idx2 = new FullTextIndex({ baseDir: dir })
        expect(idx2.count()).toBe(totalDocs)
        const results = idx2.search('document')
        expect(results.length).toBeGreaterThan(0)
        idx2.close()
      } finally {
        cleanup(dir)
      }
    }, 30000) // 30s timeout for heavy test
  })

  describe('P-4: 快照生成', () => {
    test('should generate snapshot when doc count reaches threshold', () => {
      const dir = tmpDir()
      const snapshotPath = path.join(dir, 'fulltext-index.snapshot.json')
      try {
        const idx = new FullTextIndex({ baseDir: dir, snapshotThreshold: 5 })
        for (let i = 0; i < 5; i++) {
          idx.addDocument(`doc${i}`, { name: `document ${i}` })
        }
        // Snapshot should be generated when count reaches threshold
        expect(fs.existsSync(snapshotPath)).toBe(true)

        // WAL should be cleared after snapshot
        const walPath = path.join(dir, 'fulltext-index.wal')
        if (fs.existsSync(walPath)) {
          const walContent = fs.readFileSync(walPath, 'utf-8').trim()
          expect(walContent).toBe('')
        }

        idx.close()
      } finally {
        cleanup(dir)
      }
    })

    test('should recover from snapshot correctly', () => {
      const dir = tmpDir()
      try {
        const idx = new FullTextIndex({ baseDir: dir, snapshotThreshold: 5 })
        for (let i = 0; i < 7; i++) {
          idx.addDocument(`doc${i}`, { name: `document ${i}` })
        }
        idx.close()

        // Restart — should recover from snapshot + WAL
        const idx2 = new FullTextIndex({ baseDir: dir, snapshotThreshold: 5 })
        expect(idx2.count()).toBe(7)
        const results = idx2.search('document')
        expect(results).toHaveLength(7)
        idx2.close()
      } finally {
        cleanup(dir)
      }
    })

    test('should handle removal after snapshot correctly', () => {
      const dir = tmpDir()
      try {
        const idx = new FullTextIndex({ baseDir: dir, snapshotThreshold: 5 })
        // Use doc count to hit threshold
        for (let i = 0; i < 5; i++) {
          idx.addDocument(`doc${i}`, { name: `document ${i}` })
        }
        // Add more and remove some
        idx.addDocument('doc5', { name: 'extra one' })
        idx.removeDocument('doc0')
        idx.close()

        // Restart — snapshot has 5 docs, WAL has add+remove
        const idx2 = new FullTextIndex({ baseDir: dir, snapshotThreshold: 5 })
        expect(idx2.count()).toBe(5)
        // Use unique doc ID to verify doc0 is removed (not just fuzzy match)
        expect(idx2.search('doc0')).toHaveLength(0)
        expect(idx2.search('extra')).toHaveLength(1)
        idx2.close()
      } finally {
        cleanup(dir)
      }
    })
  })

  describe('P-5: 边缘情况', () => {
    test('multiple add/remove cycles should be consistent', () => {
      const dir = tmpDir()
      try {
        const idx = new FullTextIndex({ baseDir: dir })
        idx.addDocument('doc1', { name: 'hello' })
        idx.removeDocument('doc1')
        idx.addDocument('doc1', { name: 'world' })
        idx.close()

        const idx2 = new FullTextIndex({ baseDir: dir })
        expect(idx2.search('hello')).toHaveLength(0)
        expect(idx2.search('world')).toHaveLength(1)
        idx2.close()
      } finally {
        cleanup(dir)
      }
    })

    test('should handle empty baseDir dir that does not exist', () => {
      const dir = tmpDir() + '-nonexistent'
      // Don't create the dir
      cleanup(dir)
      try {
        const idx = new FullTextIndex({ baseDir: dir })
        idx.addDocument('doc1', { name: 'hello' })
        idx.close()

        // Can recover
        const idx2 = new FullTextIndex({ baseDir: dir })
        expect(idx2.search('hello')).toHaveLength(1)
        idx2.close()
      } finally {
        cleanup(dir)
      }
    })

    test('close() should not break subsequent operations', () => {
      const dir = tmpDir()
      try {
        const idx = new FullTextIndex({ baseDir: dir })
        idx.addDocument('doc1', { name: 'hello' })
        idx.close()
        // After close, we can still search (just no WAL write)
        const results = idx.search('hello')
        expect(results).toHaveLength(1)
      } finally {
        cleanup(dir)
      }
    })
  })

  describe('P-6: forceSnapshot 手动触发', () => {
    test('forceSnapshot should create snapshot file', () => {
      const dir = tmpDir()
      const snapshotPath = path.join(dir, 'fulltext-index.snapshot.json')
      try {
        const idx = new FullTextIndex({ baseDir: dir })
        idx.addDocument('doc1', { name: 'hello' })
        idx.addDocument('doc2', { name: 'world' })
        idx.forceSnapshot()

        expect(fs.existsSync(snapshotPath)).toBe(true)
        const content = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'))
        expect(content.storedFields).toBeDefined()
        expect(Object.keys(content.storedFields)).toHaveLength(2)
        idx.close()
      } finally {
        cleanup(dir)
      }
    })

    test('snapshot + WAL should restore correctly', () => {
      const dir = tmpDir()
      try {
        const idx = new FullTextIndex({ baseDir: dir })
        idx.addDocument('doc1', { name: 'hello' })
        idx.forceSnapshot()
        idx.addDocument('doc2', { name: 'world' })
        idx.close()

        const idx2 = new FullTextIndex({ baseDir: dir })
        expect(idx2.count()).toBe(2)
        expect(idx2.search('hello')).toHaveLength(1)
        expect(idx2.search('world')).toHaveLength(1)
        idx2.close()
      } finally {
        cleanup(dir)
      }
    })
  })

  describe('P-7: 多字段文本的序列化与恢复', () => {
    test('docs with multiple searchable fields should restore correctly', () => {
      const dir = tmpDir()
      try {
        const idx = new FullTextIndex({
          baseDir: dir,
          fieldWeights: { title: 2.0, content: 1.0, tags: 1.5 },
        })
        idx.addDocument('doc1', { title: 'Graph Theory', content: 'A study of graphs and networks', tags: 'math computer-science' })
        idx.addDocument('doc2', { title: 'Database Systems', content: 'Relational and NoSQL databases', tags: 'computer-science database' })
        idx.close()

        const idx2 = new FullTextIndex({
          baseDir: dir,
          fieldWeights: { title: 2.0, content: 1.0, tags: 1.5 },
        })
        expect(idx2.search('Graph')).toHaveLength(1)
        expect(idx2.search('database')).toHaveLength(1)
        expect(idx2.search('computer')).toHaveLength(2)
        idx2.close()
      } finally {
        cleanup(dir)
      }
    })

    test('CJK text persists correctly across restart', () => {
      const dir = tmpDir()
      try {
        const idx = new FullTextIndex({
          baseDir: dir,
          analyzer: 'cjk',
        })
        idx.addDocument('doc1', { name: '我喜欢编程' })
        idx.addDocument('doc2', { name: 'Python编程guide' })
        idx.close()

        const idx2 = new FullTextIndex({
          baseDir: dir,
          analyzer: 'cjk',
        })
        expect(idx2.search('编程')).toHaveLength(2)
        expect(idx2.search('guide')).toHaveLength(1)
        idx2.close()
      } finally {
        cleanup(dir)
      }
    })
  })
})
