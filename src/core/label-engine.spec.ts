/**
 * label-engine.spec.ts — LabelEngine 持久化测试
 */
import { LabelEngine } from './label-engine'
import * as fs from 'fs'
import * as path from 'path'

function tmpDir(): string {
  const dir = path.join('/tmp', `label-persist-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
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

describe('LabelEngine Persistence', () => {
  describe('save / load round-trip', () => {
    test('should persist label data and restore it correctly', () => {
      const dir = tmpDir()
      try {
        const engine = new LabelEngine()
        engine.addNode(1, 100)
        engine.addNode(1, 200)
        engine.addNode(2, 300)
        engine.save(dir)

        // Verify file exists
        const filePath = path.join(dir, 'label-index.json')
        expect(fs.existsSync(filePath)).toBe(true)

        // Load into a fresh engine
        const engine2 = new LabelEngine()
        engine2.load(dir)

        expect(engine2.getNodeIds(1)).toEqual([100, 200])
        expect(engine2.getNodeIds(2)).toEqual([300])
        expect(engine2.getNodeIds(99)).toEqual([])

        const stats = engine2.stats()
        expect(stats.types).toBe(2)
        expect(stats.totalNodes).toBe(3)
      } finally {
        cleanup(dir)
      }
    })

    test('save + add more + save: verify all nodes survive reload', () => {
      const dir = tmpDir()
      try {
        const engine = new LabelEngine()
        engine.addNode(1, 100)
        engine.save(dir)

        // Add more after first save
        engine.addNode(1, 200)
        engine.addNode(3, 300)
        engine.save(dir)

        // Load fresh
        const engine2 = new LabelEngine()
        engine2.load(dir)

        expect(engine2.getNodeIds(1)).toEqual([100, 200])
        expect(engine2.getNodeIds(3)).toEqual([300])
        expect(engine2.stats().totalNodes).toBe(3)
      } finally {
        cleanup(dir)
      }
    })

    test('should preserve node ID types (numbers)', () => {
      const dir = tmpDir()
      try {
        const engine = new LabelEngine()
        engine.addNode(10, 999999)
        engine.addNode(10, 0)
        engine.addNode(10, -1)
        engine.save(dir)

        const engine2 = new LabelEngine()
        engine2.load(dir)
        const ids = engine2.getNodeIds(10)
        expect(ids).toContain(999999)
        expect(ids).toContain(0)
        expect(ids).toContain(-1)
      } finally {
        cleanup(dir)
      }
    })
  })

  describe('load on empty directory', () => {
    test('should not crash when directory does not exist', () => {
      const engine = new LabelEngine()
      // Should not throw
      engine.load('/nonexistent/path')
      expect(engine.stats().types).toBe(0)
    })

    test('should not crash when save dir has no index file', () => {
      const dir = tmpDir()
      try {
        // Create dir but no files
        fs.mkdirSync(dir, { recursive: true })
        const engine = new LabelEngine()
        engine.load(dir)
        expect(engine.stats().types).toBe(0)
      } finally {
        cleanup(dir)
      }
    })

    test('empty engine save produces valid file', () => {
      const dir = tmpDir()
      try {
        const engine = new LabelEngine()
        engine.save(dir)

        // Load should work
        const engine2 = new LabelEngine()
        engine2.load(dir)
        expect(engine2.stats().types).toBe(0)
        expect(engine2.stats().totalNodes).toBe(0)
      } finally {
        cleanup(dir)
      }
    })
  })

  describe('corrupt file recovery', () => {
    test('should gracefully recover from corrupt JSON', () => {
      const dir = tmpDir()
      try {
        // Write corrupt data
        const filePath = path.join(dir, 'label-index.json')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(filePath, 'this is not json', 'utf-8')

        const engine = new LabelEngine()
        engine.load(dir)
        // Should start empty, not crash
        expect(engine.stats().types).toBe(0)
        expect(engine.stats().totalNodes).toBe(0)
      } finally {
        cleanup(dir)
      }
    })

    test('should gracefully recover from partial JSON', () => {
      const dir = tmpDir()
      try {
        const filePath = path.join(dir, 'label-index.json')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(filePath, '{"version": 1, "labels": {', 'utf-8')

        const engine = new LabelEngine()
        engine.load(dir)
        expect(engine.stats().types).toBe(0)
      } finally {
        cleanup(dir)
      }
    })

    test('should gracefully recover from invalid schema', () => {
      const dir = tmpDir()
      try {
        const filePath = path.join(dir, 'label-index.json')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(filePath, JSON.stringify({ version: 'not-a-number', labels: {} }), 'utf-8')

        const engine = new LabelEngine()
        engine.load(dir)
        expect(engine.stats().types).toBe(0)
      } finally {
        cleanup(dir)
      }
    })
  })

  describe('atomic write safety', () => {
    test('should not leave .tmp file after save', () => {
      const dir = tmpDir()
      try {
        const engine = new LabelEngine()
        engine.addNode(1, 100)
        engine.save(dir)

        const tmpFile = path.join(dir, 'label-index.json.tmp')
        expect(fs.existsSync(tmpFile)).toBe(false)
        expect(fs.existsSync(path.join(dir, 'label-index.json'))).toBe(true)
      } finally {
        cleanup(dir)
      }
    })
  })

  describe('serialized format', () => {
    test('saved file should match expected format', () => {
      const dir = tmpDir()
      try {
        const engine = new LabelEngine()
        engine.addNode(1, 100)
        engine.addNode(2, 200)
        engine.save(dir)

        const raw = fs.readFileSync(path.join(dir, 'label-index.json'), 'utf-8')
        const data = JSON.parse(raw)

        expect(data).toHaveProperty('version', 1)
        expect(data).toHaveProperty('labels')
        expect(data.labels).toHaveProperty('1')
        expect(data.labels).toHaveProperty('2')
        expect(data.labels['1']).toEqual([100])
        expect(data.labels['2']).toEqual([200])
      } finally {
        cleanup(dir)
      }
    })
  })
})

// ---- LabelEngine 扩展测试 ----

describe('LabelEngine — expansion: addNode variants', () => {
  for (let iter = 0; iter < 20; iter++) {
    test(`addNode 然后 getNodeIds #${iter}`, () => {
      const engine = new LabelEngine()
      engine.addNode(iter, iter * 100)
      const ids = engine.getNodeIds(iter)
      expect(ids).toContain(iter * 100)
    })
  }

  for (let iter = 0; iter < 20; iter++) {
    test(`getNodeIds 不存在的 type 返回空 #${iter}`, () => {
      const engine = new LabelEngine()
      expect(engine.getNodeIds(iter + 1000)).toEqual([])
    })
  }

  for (let iter = 0; iter < 10; iter++) {
    test(`addNode 多次同类型 #${iter}`, () => {
      const engine = new LabelEngine()
      for (let i = 0; i < 5; i++) {
        engine.addNode(iter, i)
      }
      const ids = engine.getNodeIds(iter)
      expect(ids.length).toBe(5)
    })
  }
})

describe('LabelEngine — expansion: stats', () => {
  for (let iter = 0; iter < 15; iter++) {
    test(`stats 计数正确 #${iter}`, () => {
      const engine = new LabelEngine()
      engine.addNode(1, iter)
      const s = engine.stats()
      expect(s.totalNodes).toBe(1)
      expect(s.types).toBe(1)
    })
  }
})
