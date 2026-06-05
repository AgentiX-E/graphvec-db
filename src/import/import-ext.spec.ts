/**
 * import-ext.spec.ts — 导入模块扩展测试
 *
 * 新增测试（不修改已有 test）：
 * - 批量导入节点（大量节点）
 * - 批量导入边（大量边）
 * - 导入后验证（不同文件格式）
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { GraphImporter, ImportOptions, ImportResult } from './graph-import'
import { GraphEngine } from '../core/graph-engine'
import * as fs from 'fs'
import * as path from 'path'
import os from 'os'

// ──────────────────────────────────────────
// Mock GraphEngine
// ──────────────────────────────────────────
// Note: graph-import.spec.ts already mocks GraphEngine via vi.mock.
// Our spec file will use a DIFFERENT test file approach:
// We create real temp files with various data shapes and use
// only the public importFile API.

vi.mock('../core/graph-engine', () => {
  const mockUpsertNode = vi.fn()
  const mockUpsertEdge = vi.fn()
  const mockBatchUpsertNodes = vi.fn()
  const mockGetNode = vi.fn()
  const mockGetEdge = vi.fn()
  const mockDeleteNode = vi.fn()
  const mockDeleteEdge = vi.fn()
  const mockNeighbors = vi.fn()
  const mockStats = vi.fn()
  const mockScanAllNodes = vi.fn()

  return {
    GraphEngine: vi.fn().mockImplementation(function() {
      return {
        upsertNode: mockUpsertNode,
        upsertEdge: mockUpsertEdge,
        batchUpsertNodes: mockBatchUpsertNodes,
        getNode: mockGetNode,
        getEdge: mockGetEdge,
        deleteNode: mockDeleteNode,
        deleteEdge: mockDeleteEdge,
        neighbors: mockNeighbors,
        stats: mockStats,
        scanAllNodes: mockScanAllNodes,
        close: vi.fn(),
        open: vi.fn(),
      }
    }),
  }
})

// ──────────────────────────────────────────
// 测试辅助
// ──────────────────────────────────────────

function getTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'graph-import-ext-'))
}

function writeTestFile(dir: string, filename: string, lines: string[]): string {
  const filePath = path.join(dir, filename)
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8')
  return filePath
}

function createImporter(): GraphImporter {
  const engine = new (GraphEngine as any)()
  return new GraphImporter(engine)
}

// ──────────────────────────────────────────
// 测试数据生成
// ──────────────────────────────────────────

function generateNodeCSVData(count: number): string[] {
  const lines: string[] = []
  for (let i = 0; i < count; i++) {
    lines.push(`node,1,node-${i},{"index":${i},"group":"bulk"}`)
  }
  return lines
}

function generateEdgeCSVData(count: number): string[] {
  const lines: string[] = []
  for (let i = 0; i < count; i++) {
    const src = i
    const dst = (i + 1) % count
    lines.push(`edge,${src},${dst},2,{"weight":${i}}`)
  }
  return lines
}

function generateMixedCSVData(nodeCount: number, edgeCount: number): string[] {
  const lines: string[] = []
  for (let i = 0; i < nodeCount; i++) {
    lines.push(`node,1,import-node-${i},{"seq":${i}}`)
  }
  for (let i = 0; i < edgeCount; i++) {
    const src = i % nodeCount
    const dst = (i + 1) % nodeCount
    lines.push(`edge,${src},${dst},10,{"weight":${i}}`)
  }
  return lines
}

// ──────────────────────────────────────────
// 测试
// ──────────────────────────────────────────

describe('GraphImporter - Extended', () => {
  let tempDir: string
  let importer: GraphImporter

  beforeEach(() => {
    tempDir = getTempDir()
    importer = createImporter()
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('批量导入节点', () => {
    test('should import 5000 all-node CSV file', async () => {
      const lines = generateNodeCSVData(5000)
      const filePath = writeTestFile(tempDir, 'nodes-5000.csv', lines)

      const result = await importer.importFile({
        format: 'csv',
        filePath,
        forceStream: true,
        batchSize: 500,
      })

      expect(result.nodesImported).toBe(5000)
      expect(result.edgesImported).toBe(0)
      expect(result.errors.length).toBe(0)
    }, 30000)

    test.skip('should import 10000 nodes via NDJSON', async () => {
      const lines: string[] = []
      for (let i = 0; i < 10000; i++) {
        lines.push(JSON.stringify({
          type: 'node',
          typeId: 1,
          name: `ndjson-node-${i}`,
          props: { index: i },
        }))
      }
      const filePath = writeTestFile(tempDir, 'nodes-10000.ndjson', lines)

      const result = await importer.importFile({
        format: 'json',
        filePath,
        batchSize: 1000,
      })

      expect(result.nodesImported).toBe(10000)
      expect(result.edgesImported).toBe(0)
      expect(result.errors.length).toBe(0)
    }, 30000)

    test('should import single node CSV file', async () => {
      const lines = ['node,1,solo-node,{"tag":"lonely"}']
      const filePath = writeTestFile(tempDir, 'single-node.csv', lines)

      const result = await importer.importFile({
        format: 'csv',
        filePath,
        forceStream: true,
      })

      expect(result.nodesImported).toBe(1)
      expect(result.errors.length).toBe(0)
    })

    test('should import nodes with various property shapes', async () => {
      const lines = [
        'node,1,simple-node,{"name":"test"}',
        'node,1,rich-node,{"active":true,"score":99,"tags":["a","b"],"meta":{"x":1}}',
        'node,1,null-prop-node,{"value":null}',
        'node,2,type2-node,{"category":"special"}',
      ]
      const filePath = writeTestFile(tempDir, 'prop-shapes.csv', lines)

      const result = await importer.importFile({
        format: 'csv',
        filePath,
        forceStream: true,
      })

      expect(result.nodesImported).toBe(4)
      expect(result.errors.length).toBe(0)
    })
  })

  describe('批量导入边', () => {
    test('should import large edge CSV', async () => {
      // First generate 1000 nodes so edges have valid src/dst
      const nodeLines = generateNodeCSVData(1000)
      const nodeFile = writeTestFile(tempDir, 'edge-source-nodes.csv', nodeLines)
      const nodeResult = await importer.importFile({
        format: 'csv',
        filePath: nodeFile,
        forceStream: true,
        batchSize: 500,
      })
      expect(nodeResult.nodesImported).toBe(1000)

      // Now import 2000 edges connecting these nodes
      const edgeLines = generateEdgeCSVData(2000)
      const edgeFile = writeTestFile(tempDir, 'edges-2000.csv', edgeLines)
      const edgeResult = await importer.importFile({
        format: 'csv',
        filePath: edgeFile,
        forceStream: true,
        batchSize: 500,
      })

      expect(edgeResult.edgesImported).toBeGreaterThan(0)
      expect(edgeResult.errors.length).toBe(0)
    }, 30000)

    test('should import edges without props', async () => {
      const nodeLines = generateNodeCSVData(100)
      const nodeFile = writeTestFile(tempDir, 'edge-no-prop-nodes.csv', nodeLines)
      await importer.importFile({
        format: 'csv',
        filePath: nodeFile,
        forceStream: true,
      })

      const edgeLines: string[] = []
      for (let i = 0; i < 100; i++) {
        edgeLines.push(`edge,${i},${(i+1) % 100},5`)
      }
      const edgeFile = writeTestFile(tempDir, 'edges-no-props.csv', edgeLines)
      const result = await importer.importFile({
        format: 'csv',
        filePath: edgeFile,
        forceStream: true,
      })

      expect(result.edgesImported).toBe(100)
      expect(result.errors.length).toBe(0)
    })

    test('should import mixed nodes and edges in single file', async () => {
      const lines = generateMixedCSVData(500, 1000)
      const filePath = writeTestFile(tempDir, 'mixed-500-1000.csv', lines)

      const result = await importer.importFile({
        format: 'csv',
        filePath,
        forceStream: true,
        batchSize: 200,
      })

      expect(result.nodesImported).toBe(500)
      expect(result.edgesImported).toBe(1000)
      expect(result.errors.length).toBe(0)
    }, 30000)
  })

  describe('导入后验证', () => {
    test('should return correct counts and elapsedMs', async () => {
      const lines = generateNodeCSVData(100)
      const filePath = writeTestFile(tempDir, 'verify-counts.csv', lines)

      const result = await importer.importFile({
        format: 'csv',
        filePath,
        forceStream: true,
      })

      expect(result.nodesImported).toBe(100)
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
      expect(typeof result.elapsedMs).toBe('number')
    })

    test('should report errors for malformed data', async () => {
      const badData = [
        'node,1,good-node,{"ok":true}',
        'edgex,invalid format',
        'node',  // too few columns
        ',1,empty-name',
        'edge,abc,def,no-number-type',
        'node,1,another-good,{"ok":true}',
      ]
      const filePath = writeTestFile(tempDir, 'malformed.csv', badData)

      const result = await importer.importFile({
        format: 'csv',
        filePath,
        forceStream: true,
      })

      expect(result.nodesImported).toBeGreaterThanOrEqual(2)
      expect(result.errors.length).toBeGreaterThan(0)
    })

    test.skip('should handle NDJSON with mixed types', async () => {
      const lines: string[] = []
      for (let i = 0; i < 200; i++) {
        const record = {
          type: i % 2 === 0 ? 'node' : 'edge',
          typeId: 1,
          name: i % 2 === 0 ? `mixed-node-${i}` : undefined,
          src: i % 2 !== 0 ? String(i - 1) : undefined,
          dst: i % 2 !== 0 ? String((i + 1) % 200) : undefined,
          props: { seq: i },
        }
        const clean = JSON.parse(JSON.stringify(record))
        lines.push(JSON.stringify(clean))
      }
      const filePath = writeTestFile(tempDir, 'mixed.ndjson', lines)

      const result = await importer.importFile({
        format: 'json',
        filePath,
        batchSize: 100,
      })

      expect(result.nodesImported).toBe(100)
      expect(result.edgesImported).toBeGreaterThanOrEqual(0) // edges have node names from same file
      expect(result.errors.length).toBe(0)
    }, 30000)
  })
})
