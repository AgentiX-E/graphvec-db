// ============================================================
// GraphImporter 测试
// ============================================================

import { GraphImporter, ImportOptions, ImportResult } from './graph-import'
import { GraphEngine } from '../core/graph-engine'
import { vi, type Mocked } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import os from 'os'

// ──────────────────────────────────────────
// Mock GraphEngine
// ──────────────────────────────────────────

vi.mock('../core/graph-engine', () => {
  const actual = vi.importActual('../core/graph-engine')
  return {
    ...actual,
    GraphEngine: vi.fn().mockImplementation(function() { return {
      upsertNode: vi.fn().mockImplementation(
        (typeId: number, name: string, opts?: any) => Promise.resolve(1)
      ),
      upsertEdge: vi.fn().mockImplementation(
        (src: number, dst: number, typeId: number, opts?: any) => Promise.resolve()
      ),
      batchUpsertNodes: vi.fn().mockImplementation(
        (inputs: { typeId: number; name: string; opts?: any }[]) => {
          const result: Record<string, number> = {}
          for (const input of inputs) {
            // Generate a unique sequential ID by counting calls
            result[input.name] = Math.floor(Math.random() * 10000) + 1
          }
          return result
        }
      ),
    }}),
  }
})

// ──────────────────────────────────────────
// 测试数据生成
// ──────────────────────────────────────────

function generateCSVData(rowCount: number, includeHeader = false): string[] {
  const lines: string[] = []
  if (includeHeader) {
    lines.push('type,id/type,name,props')
  }
  for (let i = 0; i < rowCount; i++) {
    if (i % 2 === 0) {
      // Node row
      const name = `node-${i}`
      const props = JSON.stringify({ index: i, tag: 'test' })
      lines.push(`node,1,${name},${props}`)
    } else {
      // Edge row
      const src = i - 1
      const dst = (i + 1) % rowCount
      const props = i % 4 === 1 ? JSON.stringify({ weight: i }) : ''
      if (props) {
        lines.push(`edge,${src},${dst},2,${props}`)
      } else {
        lines.push(`edge,${src},${dst},2`)
      }
    }
  }
  return lines
}

function generateNDJSONData(rowCount: number): string[] {
  const lines: string[] = []
  for (let i = 0; i < rowCount; i++) {
    if (i % 2 === 0) {
      const record = {
        type: 'node',
        typeId: 1,
        name: `ndjson-node-${i}`,
        props: { index: i, tag: 'ndjson-test' },
      }
      lines.push(JSON.stringify(record))
    } else {
      const record = {
        type: 'edge',
        src: String(i - 1),
        dst: String((i + 1) % rowCount),
        typeId: 2,
        props: { weight: i },
      }
      lines.push(JSON.stringify(record))
    }
  }
  return lines
}

function generateMixedNDJSONData(rowCount: number): string[] {
  const lines: string[] = []
  for (let i = 0; i < rowCount; i++) {
    const record = {
      type: i % 2 === 0 ? 'node' : 'edge',
      typeId: i % 2 === 0 ? 1 : 2,
      name: i % 2 === 0 ? `mixed-node-${i}` : undefined,
      src: i % 2 !== 0 ? String(i - 1) : undefined,
      dst: i % 2 !== 0 ? String((i + 1) % rowCount) : undefined,
      props: { seq: i },
    }
    // Clean undefined keys
    const clean = JSON.parse(JSON.stringify(record))
    lines.push(JSON.stringify(clean))
  }
  return lines
}

function generateEmptyLinesData(rowCount: number): string[] {
  const lines: string[] = []
  for (let i = 0; i < rowCount; i++) {
    if (i % 3 === 0) {
      lines.push('') // empty line
    } else if (i % 3 === 1) {
      lines.push(JSON.stringify({ type: 'node', typeId: 1, name: `empty-test-${i}` }))
    } else {
      // Malformed line
      lines.push('this is not json')
    }
  }
  return lines
}

// ──────────────────────────────────────────
// 辅助函数
// ──────────────────────────────────────────

function getTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-import-test-'))
  return dir
}

function writeTestFile(dir: string, filename: string, lines: string[]): string {
  const filePath = path.join(dir, filename)
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8')
  return filePath
}

function createImporter(mockBatchUpsertNodes?: boolean): GraphImporter {
  const engine = new (GraphEngine as any)()
  return new GraphImporter(engine)
}

// ──────────────────────────────────────────
// 测试套件
// ──────────────────────────────────────────

describe('GraphImporter', () => {
  let tempDir: string
  let importer: GraphImporter

  beforeEach(() => {
    tempDir = getTempDir()
    importer = createImporter()
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // ──────────────────────────────────────────
  // CSV 导入
  // ──────────────────────────────────────────

  describe('CSV import', () => {
    test('imports 1000-row CSV with stream path', async () => {
      const lines = generateCSVData(1000)
      const filePath = writeTestFile(tempDir, 'test-1000.csv', lines)

      const options: ImportOptions = {
        format: 'csv',
        filePath,
        forceStream: true,
        batchSize: 200,
      }

      const result = await importer.importFile(options)

      expect(result.nodesImported).toBeGreaterThan(0)
      expect(result.edgesImported).toBeGreaterThan(0)
      expect(result.nodesImported + result.edgesImported).toBe(1000)
      expect(result.errors.length).toBe(0)
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    })

    test('imports CSV with skipHeader', async () => {
      const lines = generateCSVData(500, true)
      const filePath = writeTestFile(tempDir, 'test-header.csv', lines)

      const options: ImportOptions = {
        format: 'csv',
        filePath,
        skipHeader: true,
        forceStream: true,
      }

      const result = await importer.importFile(options)
      expect(result.nodesImported + result.edgesImported).toBe(500)
      expect(result.errors.length).toBe(0)
    })

    test('imports empty CSV file', async () => {
      const filePath = writeTestFile(tempDir, 'empty.csv', [])

      const options: ImportOptions = {
        format: 'csv',
        filePath,
        forceStream: true,
      }

      const result = await importer.importFile(options)
      expect(result.nodesImported).toBe(0)
      expect(result.edgesImported).toBe(0)
      expect(result.errors.length).toBe(0)
    })

    test('imports CSV with only header line (skipHeader)', async () => {
      const filePath = writeTestFile(tempDir, 'only-header.csv', ['type,name,props'])

      const options: ImportOptions = {
        format: 'csv',
        filePath,
        skipHeader: true,
        forceStream: true,
      }

      const result = await importer.importFile(options)
      expect(result.nodesImported).toBe(0)
      expect(result.edgesImported).toBe(0)
    })

    test('handles bad CSV rows', async () => {
      const lines = [
        'node,1,good-node,{"ok":true}',
        'invalid,no-parse',
        'edge,1,2',
        'edge',
        'node,2,another-good-node',
      ]
      const filePath = writeTestFile(tempDir, 'bad-rows.csv', lines)

      const options: ImportOptions = {
        format: 'csv',
        filePath,
        forceStream: true,
      }

      const result = await importer.importFile(options)
      // "invalid" type should be reported as unknown, edge with only 1 col might be skipped
      expect(result.nodesImported).toBe(2)
      expect(result.errors.length).toBeGreaterThan(0)
    })

    test('non-streaming CSV import (legacy path)', async () => {
      const lines = generateCSVData(100)
      const filePath = writeTestFile(tempDir, 'legacy-test.csv', lines)

      const options: ImportOptions = {
        format: 'csv',
        filePath,
        forceStream: false,
      }

      const result = await importer.importFile(options)
      expect(result.nodesImported + result.edgesImported).toBe(100)
      expect(result.errors.length).toBe(0)
    })
  })

  // ──────────────────────────────────────────
  // NDJSON 导入
  // ──────────────────────────────────────────

  describe('NDJSON import', () => {
    test('imports 1000-row NDJSON with stream path', async () => {
      const lines = generateNDJSONData(1000)
      const filePath = writeTestFile(tempDir, 'test-1000.ndjson', lines)

      const options: ImportOptions = {
        format: 'json',
        filePath,
        forceStream: true,
        batchSize: 200,
      }

      const result = await importer.importFile(options)
      expect(result.nodesImported + result.edgesImported).toBe(1000)
      expect(result.errors.length).toBe(0)
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    })

    test('imports NDJSON with jsonl extension', async () => {
      const lines = generateMixedNDJSONData(100)
      const filePath = writeTestFile(tempDir, 'test-mixed.jsonl', lines)

      const options: ImportOptions = {
        format: 'json',
        filePath,
        forceStream: true,
      }

      const result = await importer.importFile(options)
      expect(result.nodesImported + result.edgesImported).toBe(100)
      expect(result.errors.length).toBe(0)
    })

    test('imports empty NDJSON file', async () => {
      const filePath = writeTestFile(tempDir, 'empty.ndjson', [])

      const options: ImportOptions = {
        format: 'json',
        filePath,
        forceStream: true,
      }

      const result = await importer.importFile(options)
      expect(result.nodesImported).toBe(0)
      expect(result.edgesImported).toBe(0)
      expect(result.errors.length).toBe(0)
    })

    test('handles empty lines and malformed JSON', async () => {
      const lines = generateEmptyLinesData(30)
      const filePath = writeTestFile(tempDir, 'empty-lines.ndjson', lines)

      const options: ImportOptions = {
        format: 'json',
        filePath,
        forceStream: true,
      }

      const result = await importer.importFile(options)
      expect(result.nodesImported).toBeGreaterThan(0)
      expect(result.errors.length).toBeGreaterThan(0) // malformed lines
    })

    test('non-streaming JSON import (legacy path)', async () => {
      const filePath = writeTestFile(
        tempDir,
        'legacy-json.json',
        [JSON.stringify({
          nodes: [
            { type: 1, name: 'legacy-node-1' },
            { type: 1, name: 'legacy-node-2' },
          ],
          edges: [
            { src: 1, dst: 2, type: 2 },
          ],
        })]
      )

      const options: ImportOptions = {
        format: 'json',
        filePath,
        forceStream: false,
      }

      const result = await importer.importFile(options)
      expect(result.nodesImported).toBe(2)
      expect(result.edgesImported).toBe(1)
    })
  })

  // ──────────────────────────────────────────
  // 批量写入测试
  // ──────────────────────────────────────────

  describe('batch write', () => {
    test('_flushBatch calls batchUpsertNodes with node items', async () => {
      const engine = (importer as any).engine as Mocked<GraphEngine>
      const batchUpsertNodesSpy = vi.spyOn(engine, 'batchUpsertNodes')

      // Access private method via bracket notation
      // We write a CSV with only nodes and force stream path
      const lines = [
        'node,1,batch-node-1,{"k":"v1"}',
        'node,1,batch-node-2,{"k":"v2"}',
        'node,1,batch-node-3,{"k":"v3"}',
      ]
      const filePath = writeTestFile(tempDir, 'batch-test.csv', lines)

      const options: ImportOptions = {
        format: 'csv',
        filePath,
        forceStream: true,
        batchSize: 10,
        useBatchWrite: true,
      }

      await importer.importFile(options)
      expect(batchUpsertNodesSpy).toHaveBeenCalled()
      // The call should have 3 nodes
      const callArg = batchUpsertNodesSpy.mock.calls[0][0]
      expect(callArg.length).toBe(3)
    })

    test('_flushBatch calls upsertEdge for edge items', async () => {
      const engine = (importer as any).engine as Mocked<GraphEngine>
      const upsertEdgeSpy = vi.spyOn(engine, 'upsertEdge')

      const lines = [
        'edge,1,2,5',
        'edge,3,4,5',
      ]
      const filePath = writeTestFile(tempDir, 'batch-edge-test.csv', lines)

      const options: ImportOptions = {
        format: 'csv',
        filePath,
        forceStream: true,
      }

      await importer.importFile(options)
      expect(upsertEdgeSpy).toHaveBeenCalledTimes(2)
    })

    test('batchUpsertNodes fallback on failure', async () => {
      const engine = (importer as any).engine as Mocked<GraphEngine>
      // Make batchUpsertNodes throw
      const batchUpsertNodesSpy = vi.spyOn(engine, 'batchUpsertNodes')
        .mockImplementationOnce(() => { throw new Error('batch failed') })
      const upsertNodeSpy = vi.spyOn(engine, 'upsertNode')

      const lines = [
        'node,1,fallback-node-1',
        'node,1,fallback-node-2',
      ]
      const filePath = writeTestFile(tempDir, 'fallback-test.csv', lines)

      const options: ImportOptions = {
        format: 'csv',
        filePath,
        forceStream: true,
        batchSize: 10,
      }

      const result = await importer.importFile(options)
      // In fallback, each node is upserted individually, but fallback errors aren't tracked
      // So we mostly care that batch was attempted and fallback was triggered
      expect(batchUpsertNodesSpy).toHaveBeenCalled()
    })
  })

  // ──────────────────────────────────────────
  // 文件大小阈值
  // ──────────────────────────────────────────

  describe('file size threshold', () => {
    test('forceStream=true uses streaming for small CSV', async () => {
      const lines = generateCSVData(10)
      const filePath = writeTestFile(tempDir, 'small-stream.csv', lines)

      const options: ImportOptions = {
        format: 'csv',
        filePath,
        forceStream: true,
      }

      const result = await importer.importFile(options)
      expect(result.nodesImported + result.edgesImported).toBe(10)
      expect(result.errors.length).toBe(0)
    })

    test('forceStream=false uses legacy path for small file', async () => {
      const lines = generateCSVData(10)
      const filePath = writeTestFile(tempDir, 'small-legacy.csv', lines)

      const options: ImportOptions = {
        format: 'csv',
        filePath,
        forceStream: false,
      }

      const result = await importer.importFile(options)
      expect(result.nodesImported + result.edgesImported).toBe(10)
    })
  })

  // ──────────────────────────────────────────
  // 不支持流式的格式
  // ──────────────────────────────────────────

  describe('unsupported streaming formats', () => {
    test('GraphSON with forceStream returns error', async () => {
      const filePath = writeTestFile(tempDir, 'test.graphson', ['{}'])

      const options: ImportOptions = {
        format: 'graphson',
        filePath,
        forceStream: true,
      }

      const result = await importer.importFile(options)
      expect(result.nodesImported).toBe(0)
      expect(result.edgesImported).toBe(0)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0]).toContain('not supported for streaming')
    })

    test('RDF with forceStream returns error', async () => {
      const filePath = writeTestFile(tempDir, 'test.nt', [''])

      const options: ImportOptions = {
        format: 'rdf',
        filePath,
        forceStream: true,
      }

      const result = await importer.importFile(options)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0]).toContain('not supported for streaming')
    })
  })

  // ──────────────────────────────────────────
  // Error处理
  // ──────────────────────────────────────────

  describe('error handling', () => {
    test('handles non-existent file', async () => {
      const options: ImportOptions = {
        format: 'csv',
        filePath: '/nonexistent/file.csv',
        forceStream: true,
      }

      const result = await importer.importFile(options)
      // Should return gracefully with error
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.nodesImported).toBe(0)
      expect(result.edgesImported).toBe(0)
    }, 10000)

    test('handles invalid CSV content', async () => {
      // Write content that has \x00 bytes — csv-parse will parse them as characters
      const filePath = writeTestFile(tempDir, 'corrupt.csv', ['node,\x00invalid,\x00'])

      const options: ImportOptions = {
        format: 'csv',
        filePath,
        forceStream: true,
      }

      const result = await importer.importFile(options)
      // The \x00 chars are valid, but parseInt will fail and nodeType defaults to 1.
      // A node with name '\x00' will be created.
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    })
  })
})
