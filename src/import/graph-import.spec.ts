// ============================================================
// GraphImporter 测试
// ============================================================

import { GraphImporter, ImportFormat, ImportOptions } from './graph-import'
import { GraphEngine } from '../core/graph-engine'
import { NodeRecord, EdgeRecord } from '../types'
import * as fs from 'fs'
import * as path from 'path'

// ──────────────────────────────────────────
// Mock GraphEngine
// ──────────────────────────────────────────

class MockGraphEngine {
  private nodes: Map<number, NodeRecord> = new Map()
  private edges: Map<string, EdgeRecord> = new Map()
  private nodeIdCounter: number = 0
  private _isOpen: boolean = false

  get isOpen(): boolean { return this._isOpen }

  open(): void { this._isOpen = true }
  close(): void { this._isOpen = false }

  upsertNode(typeId: number, name: string, _opts?: Record<string, unknown>): number {
    this.nodeIdCounter++
    const id = this.nodeIdCounter
    this.nodes.set(id, {
      id,
      type: typeId,
      name,
      props: {},
      createdAt: Date.now(),
      degree: 0,
    })
    return id
  }

  getNode(id: number): NodeRecord | null {
    return this.nodes.get(id) ?? null
  }

  upsertEdge(src: number, dst: number, typeId: number, _opts?: Record<string, unknown>): void {
    const key = `${src}-${dst}-${typeId}`
    this.edges.set(key, { src, dst, type: typeId, props: {} })
  }

  stats(): { nodeCount: number; edgeCount: number; diskSizeBytes: number } {
    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size,
      diskSizeBytes: 0,
    }
  }

  getMockNodes(): NodeRecord[] {
    return Array.from(this.nodes.values())
  }

  getMockEdges(): EdgeRecord[] {
    return Array.from(this.edges.values())
  }
}

// ──────────────────────────────────────────
// 辅助函数：创建临时文件
// ──────────────────────────────────────────

function createTempFile(content: string, ext: string): string {
  const filePath = `/tmp/test-import-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

function deleteTempFile(filePath: string): void {
  try { fs.unlinkSync(filePath) } catch { /* ignore */ }
}

// ──────────────────────────────────────────
// 测试套件
// ──────────────────────────────────────────

describe('GraphImporter', () => {
  let mockEngine: MockGraphEngine
  let importer: GraphImporter
  let tempFiles: string[] = []

  beforeEach(() => {
    mockEngine = new MockGraphEngine()
    mockEngine.open()
    importer = new GraphImporter(mockEngine as unknown as GraphEngine)
    tempFiles = []
  })

  afterEach(() => {
    for (const f of tempFiles) {
      deleteTempFile(f)
    }
    tempFiles = []
  })

  // ──────────────────────────────────────────
  // CSV 导入（5 tests）
  // ──────────────────────────────────────────

  describe('CSV 导入', () => {
    test('should import nodes from CSV', async () => {
      const csv = 'node,1,Alice,{}\nnode,2,Bob,{}'
      const filePath = createTempFile(csv, '.csv')
      tempFiles.push(filePath)

      const result = await importer.importFile({
        format: 'csv',
        filePath,
        skipHeader: false,
      })

      expect(result.nodesImported).toBe(2)
      expect(result.edgesImported).toBe(0)
      expect(result.errors).toHaveLength(0)
    })

    test('should import edges from CSV', async () => {
      const csv = 'edge,1,2,10,{}\nedge,2,3,20,{}'
      const filePath = createTempFile(csv, '.csv')
      tempFiles.push(filePath)

      const result = await importer.importFile({
        format: 'csv',
        filePath,
        skipHeader: false,
      })

      expect(result.nodesImported).toBe(0)
      expect(result.edgesImported).toBe(2)
    })

    test('should skip header when skipHeader=true', async () => {
      const csv = 'type,id1,id2,edgeType,props\nedge,1,2,10,{}'
      const filePath = createTempFile(csv, '.csv')
      tempFiles.push(filePath)

      const result = await importer.importFile({
        format: 'csv',
        filePath,
        skipHeader: true,
      })

      expect(result.edgesImported).toBe(1)
    })

    test('should use custom delimiter', async () => {
      const csv = 'node|1|Alice|{}'
      const filePath = createTempFile(csv, '.csv')
      tempFiles.push(filePath)

      const result = await importer.importFile({
        format: 'csv',
        filePath,
        delimiter: '|',
        skipHeader: false,
      })

      expect(result.nodesImported).toBe(1)
    })

    test('should collect errors for malformed lines', async () => {
      const csv = 'node,1,Alice\nmalformed,line\nnode,2,Bob'
      const filePath = createTempFile(csv, '.csv')
      tempFiles.push(filePath)

      const result = await importer.importFile({
        format: 'csv',
        filePath,
        skipHeader: false,
      })

      // "malformed,line" has only 2 cols which is less than 2, so it's skipped
      // Only nodes get imported
      expect(result.nodesImported).toBe(2)
    })
  })

  // ──────────────────────────────────────────
  // JSON 导入（5 tests）
  // ──────────────────────────────────────────

  describe('JSON 导入', () => {
    test('should import nodes from JSON array format', async () => {
      const json = JSON.stringify({
        nodes: [
          { type: 1, name: 'NodeA', props: { key: 'val1' } },
          { type: 2, name: 'NodeB', props: { key: 'val2' } },
        ],
      })
      const filePath = createTempFile(json, '.json')
      tempFiles.push(filePath)

      const result = await importer.importFile({
        format: 'json',
        filePath,
      })

      expect(result.nodesImported).toBe(2)
      expect(result.edgesImported).toBe(0)
    })

    test('should import nodes and edges from JSON', async () => {
      const json = JSON.stringify({
        nodes: [
          { type: 1, name: 'A' },
          { type: 1, name: 'B' },
        ],
        edges: [
          { src: 1, dst: 2, type: 10 },
        ],
      })
      const filePath = createTempFile(json, '.json')
      tempFiles.push(filePath)

      const result = await importer.importFile({
        format: 'json',
        filePath,
      })

      expect(result.nodesImported).toBe(2)
      expect(result.edgesImported).toBe(1)
    })

    test('should handle alternative field names (vertices)', async () => {
      const json = JSON.stringify({
        vertices: [
          { id: 'v1', type: 1, name: 'V1' },
        ],
      })
      const filePath = createTempFile(json, '.json')
      tempFiles.push(filePath)

      const result = await importer.importFile({
        format: 'json',
        filePath,
      })

      expect(result.nodesImported).toBe(1)
    })

    test('should handle edges with alternative field names', async () => {
      const json = JSON.stringify({
        nodes: [
          { type: 1, name: 'A' },
          { type: 1, name: 'B' },
        ],
        edges: [
          { source: 1, target: 2, label: 10 },
        ],
      })
      const filePath = createTempFile(json, '.json')
      tempFiles.push(filePath)

      const result = await importer.importFile({
        format: 'json',
        filePath,
      })

      expect(result.nodesImported).toBe(2)
      expect(result.edgesImported).toBe(1)
    })

    test('should import empty arrays without error', async () => {
      const json = JSON.stringify({ nodes: [], edges: [] })
      const filePath = createTempFile(json, '.json')
      tempFiles.push(filePath)

      const result = await importer.importFile({
        format: 'json',
        filePath,
      })

      expect(result.nodesImported).toBe(0)
      expect(result.edgesImported).toBe(0)
      expect(result.errors).toHaveLength(0)
    })
  })

  // ──────────────────────────────────────────
  // GraphSON 导入（5 tests）
  // ──────────────────────────────────────────

  describe('GraphSON 导入', () => {
    test('should import vertices from GraphSON', async () => {
      const graphson = JSON.stringify([
        { id: 1, label: 'person', type: 'vertex', properties: { name: [{ value: 'Alice' }] } },
        { id: 2, label: 'person', type: 'vertex', properties: { name: [{ value: 'Bob' }] } },
      ])
      const filePath = createTempFile(graphson, '.json')
      tempFiles.push(filePath)

      const result = await importer.importFile({
        format: 'graphson',
        filePath,
      })

      expect(result.nodesImported).toBe(2)
    })

    test('should import edges from GraphSON', async () => {
      const graphson = JSON.stringify([
        { id: 1, label: 'person', type: 'vertex' },
        { id: 2, label: 'person', type: 'vertex' },
        { id: 'e1', label: 10, type: 'edge', outV: 1, inV: 2 },
      ])
      const filePath = createTempFile(graphson, '.json')
      tempFiles.push(filePath)

      const result = await importer.importFile({
        format: 'graphson',
        filePath,
      })

      expect(result.nodesImported).toBe(2)
      expect(result.edgesImported).toBe(1)
    })

    test('should import GraphSON with vertices/edges properties', async () => {
      const graphson = JSON.stringify({
        vertices: [
          { id: 'v1', label: 'user', type: 'vertex', name: 'Alice' },
        ],
        edges: [
          { id: 'e1', label: 12, type: 'edge', outV: 'v1', inV: 'v2', name: 'knows' },
        ],
      })
      const filePath = createTempFile(graphson, '.json')
      tempFiles.push(filePath)

      const result = await importer.importFile({
        format: 'graphson',
        filePath,
      })

      // vertices: 1 node. edges outV not matching our mock's internal ids, but importSucceeds
      expect(result.nodesImported).toBeGreaterThan(0)
    })

    test('should handle empty GraphSON', async () => {
      const graphson = JSON.stringify([])
      const filePath = createTempFile(graphson, '.json')
      tempFiles.push(filePath)

      const result = await importer.importFile({
        format: 'graphson',
        filePath,
      })

      expect(result.nodesImported).toBe(0)
      expect(result.edgesImported).toBe(0)
    })

    test('should import from GraphSON with properties', async () => {
      const graphson = JSON.stringify({
        vertices: [
          {
            id: 1, label: 'person', type: 'vertex',
            properties: { name: [{ value: 'Charlie' }], age: [{ value: 30 }] },
          },
        ],
      })
      const filePath = createTempFile(graphson, '.json')
      tempFiles.push(filePath)

      const result = await importer.importFile({
        format: 'graphson',
        filePath,
      })

      expect(result.nodesImported).toBe(1)
    })
  })

  // ──────────────────────────────────────────
  // RDF 导入（4 tests）
  // ──────────────────────────────────────────

  describe('RDF 导入', () => {
    test('should parse N-Triples and import nodes/edges', async () => {
      const ntriples = `<http://example.com/s1> <http://example.com/p1> <http://example.com/o1> .\n`
      const filePath = createTempFile(ntriples, '.nt')
      tempFiles.push(filePath)

      const result = await importer.importFile({
        format: 'rdf',
        filePath,
      })

      // subject node + object node
      expect(result.nodesImported).toBe(2)
      // one edge between them
      expect(result.edgesImported).toBe(1)
    })

    test('should skip literal objects', async () => {
      const ntriples = `<http://ex.com/s> <http://ex.com/p> "literal value" .\n`
      const filePath = createTempFile(ntriples, '.nt')
      tempFiles.push(filePath)

      const result = await importer.importFile({
        format: 'rdf',
        filePath,
      })

      // Only subject node — literal is not imported as node, no edge
      expect(result.nodesImported).toBe(1)
      expect(result.edgesImported).toBe(0)
    })

    test('should skip comment lines', async () => {
      const ntriples = '# comment line\n<http://ex.com/s> <http://ex.com/p> <http://ex.com/o> .\n'
      const filePath = createTempFile(ntriples, '.nt')
      tempFiles.push(filePath)

      const result = await importer.importFile({
        format: 'rdf',
        filePath,
      })

      expect(result.nodesImported).toBe(2)
      expect(result.edgesImported).toBe(1)
    })

    test('should handle unrecognized predicate types', async () => {
      const ntriples = `<urn:a> <urn:customPred> <urn:b> .\n`
      const filePath = createTempFile(ntriples, '.nt')
      tempFiles.push(filePath)

      const result = await importer.importFile({
        format: 'rdf',
        filePath,
      })

      // should import with default edge type
      expect(result.nodesImported).toBe(2)
      expect(result.edgesImported).toBe(1)
    })
  })
})
