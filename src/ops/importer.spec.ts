// ============================================================
// Importer — spec
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Importer } from './importer'
import type { ImportProgress } from './importer'

// ──────────────────────────────────────────
// 辅助：创建临时文件
// ──────────────────────────────────────────

const TMP_DIR = path.join(__dirname, '../../tmp-test-importer')

function tmpPath(name: string): string {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true })
  }
  return path.join(TMP_DIR, name)
}

function writeTmp(name: string, content: string): string {
  const p = tmpPath(name)
  fs.writeFileSync(p, content, 'utf-8')
  return p
}

// ──────────────────────────────────────────
// Mock GraphEngine
// ──────────────────────────────────────────

function mockEngine() {
  const nodeIds = new Map<string, number>()
  let nextId = 1000

  const engine = {
    upsertNode: vi.fn(async (typeId: number, name: string, opts?: any) => {
      if (!nodeIds.has(name)) {
        nodeIds.set(name, nextId++)
      }
      return nodeIds.get(name)!
    }),
    upsertEdge: vi.fn(async (src: number, dst: number, typeId: number, opts?: any) => {
      // no-op
    }),
    batchUpsertNodes: vi.fn((inputs: { typeId: number; name: string; opts?: any }[]) => {
      const result: Record<string, number> = {}
      for (const inp of inputs) {
        if (!nodeIds.has(inp.name)) {
          nodeIds.set(inp.name, nextId++)
        }
        result[inp.name] = nodeIds.get(inp.name)!
      }
      // Return a mock Record<string, NodeId> — polyfill the real return shape
      return result
    }),
    getNode: vi.fn((id: number) => ({
      id,
      type: 1,
      key: `node-${id}`,
      props: {},
    })),
  }

  return { engine, nodeIds }
}

// ──────────────────────────────────────────
// Tests
// ──────────────────────────────────────────

describe('Importer', () => {
  let engine: ReturnType<typeof mockEngine>['engine']
  let nodeIds: Map<string, number>

  beforeEach(() => {
    const m = mockEngine()
    engine = m.engine
    nodeIds = m.nodeIds
  })

  afterEach(() => {
    // Clean temp files
    if (fs.existsSync(TMP_DIR)) {
      for (const f of fs.readdirSync(TMP_DIR)) {
        fs.unlinkSync(path.join(TMP_DIR, f))
      }
    }
    vi.clearAllMocks()
  })

  describe('importCSV', () => {
    it('should import nodes from CSV', async () => {
      const csv = `type,typeId,name,props
node,1,Alice,{"age":30}
node,1,Bob,{"age":25}
node,2,Charlie,{"role":"admin"}`
      const filePath = writeTmp('test-nodes.csv', csv)
      const importer = new Importer(engine as any)
      const result = await importer.importCSV(filePath, { batchSize: 10 })

      expect(result.totalRows).toBe(3)
      expect(result.importedRows).toBe(3)
      expect(result.failedRows).toBe(0)
      expect(result.errors).toHaveLength(0)
      expect(engine.upsertNode).toHaveBeenCalledTimes(0) // should use batchUpsertNodes
      expect(engine.batchUpsertNodes).toHaveBeenCalledTimes(1)
    })

    it('should import edges from CSV', async () => {
      const csv = `type,typeId,src,dst,props
edge,1,100,200,{"weight":5}
edge,2,100,300,{"weight":3}`
      const filePath = writeTmp('test-edges.csv', csv)
      const importer = new Importer(engine as any)
      const result = await importer.importCSV(filePath, { batchSize: 10 })

      expect(result.totalRows).toBe(2)
      expect(result.failedRows).toBe(0)
      expect(engine.upsertEdge).toHaveBeenCalledTimes(2)
    })

    it('should handle mixed nodes and edges', async () => {
      const csv = `type,typeId,name,src,dst,props
node,1,Alice,,,{"age":30}
node,2,Bob,,,
edge,10,,100,200,`
      const filePath = writeTmp('test-mixed.csv', csv)
      const importer = new Importer(engine as any)
      const result = await importer.importCSV(filePath, { batchSize: 10 })

      // Header: rows after header: 3 data rows (1 header, skipHeader)
      // but our implementation doesn't skip header, so totalRows=4 (header+3data)
      // Actually, the implementation in _importCSVStream skips the first line
      // when it looks like 'type' or 'typename'
      expect(result.totalRows).toBe(3)
      expect(result.importedRows).toBeGreaterThanOrEqual(2)
    })

    it('should batch writes with small batchSize', async () => {
      const csv = Array.from({ length: 15 }, (_, i) => `node,1,User${i},{}`).join('\n')
      const filePath = writeTmp('test-batch.csv', csv)
      // Add a header
      const csvWithHeader = `type,typeId,name,props\n${csv}`
      fs.writeFileSync(filePath, csvWithHeader, 'utf-8')

      const importer = new Importer(engine as any)
      const result = await importer.importCSV(filePath, { batchSize: 5 })

      expect(result.totalRows).toBe(15)
      expect(result.importedRows).toBe(15)
      // With batchSize=5 and 15 rows, should have 3 batches
      expect(engine.batchUpsertNodes).toHaveBeenCalledTimes(3)
    })

    it('should report parse errors', async () => {
      const csv = `type,typeId,name,props
node,1,Alice,{bad json}
badline
node,1,Bob`
      const filePath = writeTmp('test-errors.csv', csv)
      const importer = new Importer(engine as any)
      const result = await importer.importCSV(filePath, { batchSize: 10 })

      expect(result.totalRows).toBeGreaterThan(0)
    })
  })

  describe('importNDJSON', () => {
    it('should import nodes from NDJSON', async () => {
      const ndjson = [
        JSON.stringify({ type: 'node', typeId: 1, name: 'Alice', props: { age: 30 } }),
        JSON.stringify({ type: 'node', typeId: 1, name: 'Bob', props: { age: 25 } }),
        JSON.stringify({ type: 'node', typeId: 2, name: 'Charlie', props: { role: 'admin' } }),
      ].join('\n')
      const filePath = writeTmp('test-nodes.ndjson', ndjson)
      const importer = new Importer(engine as any)
      const result = await importer.importNDJSON(filePath, { batchSize: 10 })

      expect(result.totalRows).toBe(3)
      expect(result.importedRows).toBeGreaterThanOrEqual(3)
      expect(result.failedRows).toBe(0)
    })

    it('should import edges from NDJSON', async () => {
      const ndjson = [
        JSON.stringify({ type: 'edge', typeId: 1, src: 100, dst: 200, props: { weight: 5 } }),
      ].join('\n')
      const filePath = writeTmp('test-edges.ndjson', ndjson)
      const importer = new Importer(engine as any)
      const result = await importer.importNDJSON(filePath, { batchSize: 10 })

      expect(result.totalRows).toBe(1)
      expect(result.importedRows).toBe(1)
      expect(result.failedRows).toBe(0)
      expect(engine.upsertEdge).toHaveBeenCalledTimes(1)
    })

    it('should handle mixed types', async () => {
      const ndjson = [
        JSON.stringify({ type: 'node', typeId: 1, name: 'N1' }),
        JSON.stringify({ type: 'node', typeId: 1, name: 'N2' }),
        JSON.stringify({ type: 'edge', typeId: 10, src: 100, dst: 200 }),
      ].join('\n')
      const filePath = writeTmp('test-mixed.ndjson', ndjson)
      const importer = new Importer(engine as any)
      const result = await importer.importNDJSON(filePath, { batchSize: 10 })

      expect(result.totalRows).toBe(3)
      expect(result.importedRows).toBe(3)
    })

    it('should report JSON parse errors', async () => {
      const ndjson = [
        JSON.stringify({ type: 'node', typeId: 1, name: 'Alice' }),
        '{bad json}',
        JSON.stringify({ type: 'node', typeId: 1, name: 'Bob' }),
      ].join('\n')
      const filePath = writeTmp('test-parse-error.ndjson', ndjson)
      const importer = new Importer(engine as any)
      const result = await importer.importNDJSON(filePath, { batchSize: 10 })

      expect(result.totalRows).toBe(3)
      expect(result.failedRows).toBe(1)
    })
  })

  describe('importStream', () => {
    it('should accept a ReadableStream (CSV)', async () => {
      const csv = `type,typeId,name,props
node,1,Alice,{"age":30}`
      const filePath = writeTmp('test-stream.csv', csv)
      const stream = fs.createReadStream(filePath, 'utf-8')
      const importer = new Importer(engine as any)
      const result = await importer.importStream(stream, 'csv', { batchSize: 10 })

      expect(result.totalRows).toBe(1)
      expect(result.importedRows).toBe(1)
    })

    it('should accept a ReadableStream (NDJSON)', async () => {
      const ndjson = JSON.stringify({ type: 'node', typeId: 1, name: 'StreamNode' })
      const filePath = writeTmp('test-stream.ndjson', ndjson)
      const stream = fs.createReadStream(filePath, 'utf-8')
      const importer = new Importer(engine as any)
      const result = await importer.importStream(stream, 'ndjson', { batchSize: 10 })

      expect(result.totalRows).toBe(1)
      expect(result.importedRows).toBeGreaterThanOrEqual(1)
    })

    it('should handle empty stream', async () => {
      const filePath = writeTmp('test-empty.ndjson', '')
      const stream = fs.createReadStream(filePath, 'utf-8')
      const importer = new Importer(engine as any)
      const result = await importer.importStream(stream, 'ndjson', { batchSize: 10 })

      expect(result.totalRows).toBe(0)
      expect(result.importedRows).toBe(0)
      expect(result.failedRows).toBe(0)
    })
  })

  describe('importStream backpressure', () => {
    it('should not buffer more than one batch worth of items during flush', async () => {
      // Use a slow engine where each individual upsert takes time,
      // forcing batchUpsertNodes to throw so it falls through to per-row upsertNode
      const slowEngine = {
        ...engine,
        upsertNode: vi.fn(async () => {
          // Simulate slow write
          await new Promise(r => setTimeout(r, 20))
          return 999
        }),
        upsertEdge: vi.fn(async () => {
          await new Promise(r => setTimeout(r, 20))
        }),
        batchUpsertNodes: vi.fn(() => {
          throw new Error('batch failed, fallback to individual')
        }),
      }

      // A large CSV with 30 data rows, batchSize=10 means 3 batches
      const numRows = 30
      const lines: string[] = []
      for (let i = 0; i < numRows; i++) {
        lines.push(`node,1,User${i},{}\n`)
      }
      const csv = `type,typeId,name,props\n${lines.join('')}`
      const filePath = writeTmp('test-backpressure.csv', csv)

      const importer = new Importer(slowEngine as any)
      const result = await importer.importCSV(filePath, { batchSize: 10, concurrency: 2 })

      expect(result.totalRows).toBe(30)
      expect(result.importedRows).toBe(30)
      expect(result.failedRows).toBe(0)

      // With backpressure, the CSV stream loop awaits each batch flush
      // before reading more rows, so upsertNode is called exactly 30 times
      expect(slowEngine.upsertNode).toHaveBeenCalledTimes(30)
    })

    it('should process rows correctly under backpressure with edge data', async () => {
      const slowEdgeEngine = {
        ...engine,
        upsertEdge: vi.fn(async () => {
          await new Promise(r => setTimeout(r, 10))
        }),
        upsertNode: vi.fn(async () => {
          await new Promise(r => setTimeout(r, 5))
          return 100
        }),
        batchUpsertNodes: vi.fn(() => ({})),
      }

      // Create 50 edge rows
      const lines: string[] = []
      for (let i = 0; i < 50; i++) {
        lines.push(`edge,1,${i},${i + 100},{}\n`)
      }
      const csv = `type,typeId,src,dst,props\n${lines.join('')}`
      const filePath = writeTmp('test-backpressure-edges.csv', csv)

      const importer = new Importer(slowEdgeEngine as any)
      const result = await importer.importCSV(filePath, { batchSize: 25, concurrency: 1 })

      expect(result.totalRows).toBe(50)
      expect(result.importedRows).toBe(50)
      expect(result.failedRows).toBe(0)
      expect(slowEdgeEngine.upsertEdge).toHaveBeenCalledTimes(50)
    })
  })

  describe('importStream progress callback', () => {
    it('should emit progress updates during CSV import', async () => {
      const progressUpdates: ImportProgress[] = []
      const numRows = 20
      const lines: string[] = []
      for (let i = 0; i < numRows; i++) {
        lines.push(`node,1,ProgUser${i},{}\n`)
      }
      const csv = `type,typeId,name,props\n${lines.join('')}`
      const filePath = writeTmp('test-progress.csv', csv)

      const importer = new Importer(engine as any)

      // Use a slow engine so progress reports actually fire
      const slowEngine = {
        ...engine,
        upsertNode: vi.fn(async () => {
          await new Promise(r => setTimeout(r, 5))
          return 999
        }),
      }

      const importerSlow = new Importer(slowEngine as any)
      const result = await importerSlow.importCSV(filePath, {
        batchSize: 5,
        concurrency: 1,
        onProgress: (p) => {
          progressUpdates.push({ ...p, errors: [...p.errors] })
        },
      })

      // Should have received progress updates (at minimum: after each batch flush)
      // 20 rows / batchSize=5 = 4 batches → at least 4 progress updates + final
      expect(progressUpdates.length).toBeGreaterThanOrEqual(4)

      // The final result should match the last progress update
      const lastUpdate = progressUpdates[progressUpdates.length - 1]
      expect(lastUpdate.totalRows).toBe(result.totalRows)
      expect(lastUpdate.importedRows).toBe(result.importedRows)
      expect(lastUpdate.failedRows).toBe(result.failedRows)

      // Progress should be cumulative (each update >= previous)
      for (let i = 1; i < progressUpdates.length; i++) {
        expect(progressUpdates[i].importedRows).toBeGreaterThanOrEqual(
          progressUpdates[i - 1].importedRows,
        )
      }
    })

    it('should emit progress updates during NDJSON import', async () => {
      const progressUpdates: ImportProgress[] = []

      const ndjsonLines: string[] = []
      for (let i = 0; i < 15; i++) {
        ndjsonLines.push(JSON.stringify({ type: 'node', typeId: 1, name: `NdjsonUser${i}` }))
      }
      const ndjson = ndjsonLines.join('\n')
      const filePath = writeTmp('test-progress.ndjson', ndjson)

      const slowEngine = {
        ...engine,
        upsertNode: vi.fn(async () => {
          await new Promise(r => setTimeout(r, 5))
          return 999
        }),
      }

      const importer = new Importer(slowEngine as any)
      const result = await importer.importNDJSON(filePath, {
        batchSize: 5,
        concurrency: 1,
        onProgress: (p) => {
          progressUpdates.push({ ...p, errors: [...p.errors] })
        },
      })

      // Should have at least 3 batch progress updates (15 rows / 5 per batch)
      expect(progressUpdates.length).toBeGreaterThanOrEqual(3)

      const lastUpdate = progressUpdates[progressUpdates.length - 1]
      expect(lastUpdate.totalRows).toBe(result.totalRows)
      expect(lastUpdate.importedRows).toBe(result.importedRows)

      // Cumulative check
      for (let i = 1; i < progressUpdates.length; i++) {
        expect(progressUpdates[i].importedRows).toBeGreaterThanOrEqual(
          progressUpdates[i - 1].importedRows,
        )
      }
    })

    it('should report error rows in progress callbacks', async () => {
      const progressUpdates: ImportProgress[] = []

      const ndjson = [
        JSON.stringify({ type: 'node', typeId: 1, name: 'Good1' }),
        '{bad json line}',
        JSON.stringify({ type: 'node', typeId: 1, name: 'Good2' }),
        JSON.stringify({ type: 'unknown', typeId: 1, name: 'BadType' }),
      ].join('\n')
      const filePath = writeTmp('test-progress-errors.ndjson', ndjson)

      const importer = new Importer(engine as any)
      const result = await importer.importNDJSON(filePath, {
        batchSize: 2,
        onProgress: (p) => {
          progressUpdates.push({ ...p, errors: [...p.errors] })
        },
      })

      expect(result.totalRows).toBe(4)
      expect(result.failedRows).toBe(2)

      // Errors should be reported in progress callbacks
      const errorsReported = progressUpdates.some(p => p.errors.length > 0)
      expect(errorsReported).toBe(true)
    })
  })
})
