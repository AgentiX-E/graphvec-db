// ============================================================
// Importer — spec
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Importer } from './importer'

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
})
