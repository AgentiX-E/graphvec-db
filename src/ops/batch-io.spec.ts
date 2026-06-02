/**
 * batch-io 单元测试
 *
 * 测试 JSONL/CSV 格式的批量导入和导出功能。
 * 使用临时文件而非真实数据库。
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { batchImport, batchExport, ImportRow, NodeImportRow, EdgeImportRow } from './batch-io'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-io-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function tmpFile(name: string): string {
  return path.join(tmpDir, name)
}

describe('batchImport - JSONL', () => {
  test('import nodes from JSONL', async () => {
    const filePath = tmpFile('nodes.jsonl')
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: 'node', id: 1, name: 'Alice', props: { age: 30, city: 'NYC' } }),
      JSON.stringify({ type: 'node', id: 2, name: 'Bob', props: { age: 25 } }),
      JSON.stringify({ type: 'node', id: 3, name: 'Charlie' }),
    ].join('\n'))

    const result = await batchImport({ filePath })
    expect(result.totalRows).toBe(3)
    expect(result.successRows).toBe(3)
    expect(result.errorRows).toBe(0)
    expect(result.nodes).toHaveLength(3)
    expect(result.edges).toHaveLength(0)
    expect(result.nodes[0].props).toEqual({ age: 30, city: 'NYC' })
  })

  test('import edges from JSONL', async () => {
    const filePath = tmpFile('edges.jsonl')
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: 'edge', src: 1, dst: 2, weight: 0.5 }),
      JSON.stringify({ type: 'edge', src: 2, dst: 3, weight: 1.0 }),
    ].join('\n'))

    const result = await batchImport({ filePath })
    expect(result.totalRows).toBe(2)
    expect(result.nodes).toHaveLength(0)
    expect(result.edges).toHaveLength(2)
    expect(result.edges[0].weight).toBe(0.5)
  })

  test('mixed nodes and edges', async () => {
    const filePath = tmpFile('mixed.jsonl')
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: 'node', id: 1, name: 'A' }),
      JSON.stringify({ type: 'edge', src: 1, dst: 2 }),
      JSON.stringify({ type: 'node', id: 2, name: 'B' }),
    ].join('\n'))

    const result = await batchImport({ filePath })
    expect(result.totalRows).toBe(3)
    expect(result.nodes).toHaveLength(2)
    expect(result.edges).toHaveLength(1)
  })

  test('auto-detect edge by src/dst', async () => {
    const filePath = tmpFile('auto.jsonl')
    fs.writeFileSync(filePath, JSON.stringify({ src: 1, dst: 2, weight: 0.8 }))

    const result = await batchImport({ filePath })
    expect(result.edges).toHaveLength(1)
    expect(result.nodes).toHaveLength(0)
  })

  test('error handling with non-JSON line', async () => {
    const filePath = tmpFile('bad.jsonl')
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: 'node', id: 1 }),
      'not valid json',
      JSON.stringify({ type: 'node', id: 2 }),
    ].join('\n'))

    const errors: string[] = []
    const result = await batchImport({ filePath, onError: (row, err) => errors.push(err) })
    expect(result.successRows).toBe(2)
    expect(result.errorRows).toBe(1)
    expect(errors).toHaveLength(1)
  })

  test('strict mode throws on error', async () => {
    const filePath = tmpFile('strict.jsonl')
    fs.writeFileSync(filePath, 'not valid json\n')

    await expect(batchImport({ filePath, strict: true })).rejects.toThrow()
  })

  test('skip empty lines', async () => {
    const filePath = tmpFile('empty.jsonl')
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: 'node', id: 1 }),
      '',
      '',
      JSON.stringify({ type: 'node', id: 2 }),
    ].join('\n'))

    const result = await batchImport({ filePath, skipEmptyLines: true })
    expect(result.successRows).toBe(2)
  })

  test('progress callback', async () => {
    const filePath = tmpFile('progress.jsonl')
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ type: 'node', id: i, name: `Node${i}` }),
    )
    fs.writeFileSync(filePath, lines.join('\n'))

    const progressCalls: Array<{ processed: number; total: number }> = []
    await batchImport({ filePath, onProgress: (p, t) => progressCalls.push({ processed: p, total: t }) })

    expect(progressCalls.length).toBeGreaterThanOrEqual(10)
  })

  test('empty file returns empty result', async () => {
    const filePath = tmpFile('empty.jsonl')
    fs.writeFileSync(filePath, '')

    const result = await batchImport({ filePath })
    expect(result.totalRows).toBe(0)
    expect(result.nodes).toHaveLength(0)
    expect(result.edges).toHaveLength(0)
  })
})

describe('batchImport - CSV', () => {
  test('import nodes from CSV', async () => {
    const filePath = tmpFile('nodes.csv')
    fs.writeFileSync(filePath, [
      'id,name,prop_age,prop_city',
      '1,Alice,30,NYC',
      '2,Bob,25,',
      '3,Charlie,,LA',
    ].join('\n'))

    const result = await batchImport({ filePath, format: 'csv' })
    expect(result.totalRows).toBe(3)
    expect(result.successRows).toBe(3)
    expect(result.nodes).toHaveLength(3)
    expect(result.nodes[0].props?.age).toBe(30)
    expect(result.nodes[0].props?.city).toBe('NYC')
  })

  test('import edges from CSV', async () => {
    const filePath = tmpFile('edges.csv')
    fs.writeFileSync(filePath, [
      'src,dst,weight,prop_label',
      '1,2,0.5,friends',
      '2,3,1.0,colleagues',
    ].join('\n'))

    const result = await batchImport({ filePath, format: 'csv' })
    expect(result.totalRows).toBe(2)
    expect(result.edges).toHaveLength(2)
    expect(result.edges[0].src).toBe(1)
    expect(result.edges[0].weight).toBe(0.5)
    expect(result.edges[1].props?.label).toBe('colleagues')
  })

  test('CSV with quoted fields', async () => {
    const filePath = tmpFile('quoted.csv')
    fs.writeFileSync(filePath, [
      'id,name,prop_desc',
      '1,"Alice","Engineer, AI team"',
      '2,"Bob","Data Scientist"',
    ].join('\n'))

    const result = await batchImport({ filePath, format: 'csv' })
    expect(result.nodes).toHaveLength(2)
    expect(result.nodes[0].props?.desc).toBe('Engineer, AI team')
  })

  test('CSV without header', async () => {
    const filePath = tmpFile('noheader.csv')
    fs.writeFileSync(filePath, [
      '1,Alice,30',
      '2,Bob,25',
    ].join('\n'))

    const result = await batchImport({
      filePath,
      format: 'csv',
      csvOptions: { hasHeader: false },
    })
    // Without header, column mapping uses defaults
    expect(result.totalRows).toBe(2)
    expect(result.successRows).toBe(2)
  })

  test('CSV with custom delimiter', async () => {
    const filePath = tmpFile('tsv.csv')
    fs.writeFileSync(filePath, [
      'id\tname\tprop_age',
      '1\tAlice\t30',
      '2\tBob\t25',
    ].join('\n'))

    const result = await batchImport({
      filePath,
      format: 'csv',
      csvOptions: { delimiter: '\t' },
    })
    expect(result.nodes).toHaveLength(2)
    expect(result.nodes[0].props?.age).toBe(30)
  })
})

describe('batchExport - JSONL', () => {
  test('export nodes to JSONL', async () => {
    const filePath = tmpFile('out.jsonl')
    const rows: NodeImportRow[] = [
      { type: 'node', id: 1, name: 'Alice', props: { age: 30 } },
      { type: 'node', id: 2, name: 'Bob' },
    ]

    const result = await batchExport({ filePath, format: 'jsonl', rows })
    expect(result.totalRows).toBe(2)
    expect(result.filePath).toBe(filePath)
    expect(result.bytesWritten).toBeGreaterThan(0)

    // Verify content
    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(2)
    const parsed = lines.map((l) => JSON.parse(l))
    expect(parsed[0].name).toBe('Alice')
    expect(parsed[0].props.age).toBe(30)
  })

  test('export edges to JSONL', async () => {
    const filePath = tmpFile('edges-out.jsonl')
    const rows: EdgeImportRow[] = [
      { type: 'edge', src: 1, dst: 2, weight: 0.5 },
      { type: 'edge', src: 2, dst: 3, weight: 1.0 },
    ]

    const result = await batchExport({ filePath, format: 'jsonl', rows })
    expect(result.totalRows).toBe(2)

    const content = fs.readFileSync(filePath, 'utf-8')
    const parsed = content.trim().split('\n').map((l) => JSON.parse(l))
    expect(parsed[0].type).toBe('edge')
    expect(parsed[0].weight).toBe(0.5)
  })

  test('overwrite protection', async () => {
    const filePath = tmpFile('exists.jsonl')
    fs.writeFileSync(filePath, 'old')
    const rows: ImportRow[] = [{ type: 'node', id: 1 }]

    await expect(batchExport({ filePath, format: 'jsonl', rows })).rejects.toThrow()
  })

  test('overwrite with option', async () => {
    const filePath = tmpFile('override.jsonl')
    fs.writeFileSync(filePath, 'old')
    const rows: ImportRow[] = [{ type: 'node', id: 42, name: 'New' }]

    await batchExport({ filePath, format: 'jsonl', rows, overwrite: true })
    const content = fs.readFileSync(filePath, 'utf-8')
    expect(content).toContain('New')
  })
})

describe('batchExport - CSV', () => {
  test('export nodes to CSV', async () => {
    const filePath = tmpFile('out.csv')
    const rows: NodeImportRow[] = [
      { type: 'node', id: 1, name: 'Alice', props: { age: 30, city: 'NYC' } },
      { type: 'node', id: 2, name: 'Bob', props: { age: 25 } },
    ]

    const result = await batchExport({ filePath, format: 'csv', rows })
    expect(result.totalRows).toBe(2)

    const content = fs.readFileSync(filePath, 'utf-8')
    expect(content).toContain('Alice')
    expect(content).toContain('30')
    expect(content).toContain('NYC')
  })

  test('export edges to CSV', async () => {
    const filePath = tmpFile('edges-out.csv')
    const rows: EdgeImportRow[] = [
      { type: 'edge', src: 1, dst: 2, weight: 0.5 },
      { type: 'edge', src: 2, dst: 3 },
    ]

    await batchExport({ filePath, format: 'csv', rows })
    const content = fs.readFileSync(filePath, 'utf-8')
    expect(content).toContain('0.5')
    // Second edge has no weight — should just have empty field
  })

  test('export with custom delimiter', async () => {
    const filePath = tmpFile('tab.csv')
    const rows: ImportRow[] = [
      { type: 'node', id: 1, name: 'A' },
      { type: 'node', id: 2, name: 'B' },
    ]

    await batchExport({ filePath, format: 'csv', rows, csvOptions: { delimiter: '\t' } })
    const content = fs.readFileSync(filePath, 'utf-8')
    expect(content).toContain('\t')
    // Verify it's tab-separated
    const lines = content.trim().split('\n')
    expect(lines[1].split('\t').length).toBeGreaterThan(1)
  })

  test('round-trip: export then import preserves data', async () => {
    const filePath = tmpFile('roundtrip.jsonl')
    const original: ImportRow[] = [
      { type: 'node', id: 1, name: 'Alice', props: { age: 30 } },
      { type: 'node', id: 2, name: 'Bob', props: { age: 25, city: 'SF' } },
      { type: 'edge', src: 1, dst: 2, weight: 0.8 },
    ]

    // Export
    await batchExport({ filePath, format: 'jsonl', rows: original })

    // Import back
    const result = await batchImport({ filePath })

    expect(result.nodes).toHaveLength(2)
    expect(result.edges).toHaveLength(1)
    expect(result.nodes[0].props?.age).toBe(30)
    expect(result.edges[0].weight).toBe(0.8)
  })
})
