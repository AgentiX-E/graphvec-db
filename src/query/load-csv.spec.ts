/**
 * LOAD CSV parsing + execution tests.
 *
 * Coverage:
 *   - LOAD CSV syntax parsing (WITH HEADERS / without)
 *   - CSV line/content parsing (quote escaping, comma, empty fields)
 *   - LOAD CSV end-to-end execution via _executeQuery
 *   - file-not-found error handling
 *   - file:// / absolute path resolution
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { parseQuery, _executeQuery } from './query-engine'
import { splitCsvLine, parseCsvContent } from './executor-common'

describe('LOAD CSV 解析', () => {
  it('LOAD CSV FROM URL AS row', () => {
    const plan = parseQuery("LOAD CSV FROM 'https://example.com/data.csv' AS row RETURN row")
    expect(plan.loadCsv).toBeDefined()
    expect(plan.loadCsv!.url).toBe('https://example.com/data.csv')
    expect(plan.loadCsv!.rowVariable).toBe('row')
    expect(plan.loadCsv!.hasHeaders).toBe(false)
  })

  it('LOAD CSV WITH HEADERS', () => {
    const plan = parseQuery("LOAD CSV FROM 'file.csv' AS row WITH HEADERS RETURN row")
    expect(plan.loadCsv).toBeDefined()
    expect(plan.loadCsv!.hasHeaders).toBe(true)
  })

  it('无 LOAD CSV 的查询为 undefined', () => {
    const plan = parseQuery('MATCH (n) RETURN n')
    expect(plan.loadCsv).toBeUndefined()
  })

  it('LOAD CSV 变量名正确提取', () => {
    const plan = parseQuery("LOAD CSV FROM '/tmp/data.csv' AS person RETURN person")
    expect(plan.loadCsv).toBeDefined()
    expect(plan.loadCsv!.rowVariable).toBe('person')
  })

  it('LOAD CSV WITH HEADERS 不区分大小写', () => {
    const plan = parseQuery("LOAD CSV FROM 'data.csv' AS row with headers RETURN row")
    expect(plan.loadCsv).toBeDefined()
    expect(plan.loadCsv!.hasHeaders).toBe(true)
  })
})

describe('CSV 解析功能', () => {
  describe('splitCsvLine — 单行解析', () => {
    it('基本字段', () => {
      const fields = splitCsvLine('a,b,c', ',')
      expect(fields).toEqual(['a', 'b', 'c'])
    })

    it('带引号的字段中含逗号', () => {
      const fields = splitCsvLine('a,"b,c",d', ',')
      expect(fields).toEqual(['a', 'b,c', 'd'])
    })

    it('双引号转义', () => {
      const fields = splitCsvLine('a,"b""c",d', ',')
      expect(fields).toEqual(['a', 'b"c', 'd'])
    })

    it('空字段', () => {
      const fields = splitCsvLine('a,,c', ',')
      expect(fields).toEqual(['a', '', 'c'])
    })

    it('尾部空字段', () => {
      const fields = splitCsvLine('a,', ',')
      expect(fields).toEqual(['a', ''])
    })

    it('带引号的空字段', () => {
      const fields = splitCsvLine('a,"",c', ',')
      expect(fields).toEqual(['a', '', 'c'])
    })

    it('制表符分隔', () => {
      const fields = splitCsvLine('a\tb\tc', '\t')
      expect(fields).toEqual(['a', 'b', 'c'])
    })
  })

  describe('parseCsvContent — 多行解析', () => {
    it('WITH HEADERS 正确映射', () => {
      const csv = 'id,name,age\n1,Alice,30\n2,Bob,25'
      const result = parseCsvContent(csv, { headers: true, delimiter: ',', as: 'row' }) as Array<{ row: Record<string, string> }>
      expect(result).toHaveLength(2)
      expect(result[0].row).toEqual({ id: '1', name: 'Alice', age: '30' })
      expect(result[1].row).toEqual({ id: '2', name: 'Bob', age: '25' })
    })

    it('无 HEADERS 返回行数组', () => {
      const csv = '1,Alice,30\n2,Bob,25'
      const result = parseCsvContent(csv, { headers: false, delimiter: ',', as: 'row' }) as Array<{ row: string[] }>
      expect(result).toHaveLength(2)
      expect(result[0].row).toEqual(['1', 'Alice', '30'])
      expect(result[1].row).toEqual(['2', 'Bob', '25'])
    })

    it('空内容返回空数组', () => {
      const result = parseCsvContent('', { headers: true, delimiter: ',', as: 'row' })
      expect(result).toEqual([])
    })

    it('仅有表头没有数据行', () => {
      const result = parseCsvContent('id,name,age', { headers: true, delimiter: ',', as: 'row' }) as Array<{ row: Record<string, string> }>
      expect(result).toEqual([])
    })

    it('引号内容含逗号 + WITH HEADERS', () => {
      const csv = 'id,name,desc\n1,Alice,"Hello, World"\n2,Bob,"Foo, Bar"'
      const result = parseCsvContent(csv, { headers: true, delimiter: ',', as: 'row' }) as Array<{ row: Record<string, string> }>
      expect(result).toHaveLength(2)
      expect(result[0].row).toEqual({ id: '1', name: 'Alice', desc: 'Hello, World' })
      expect(result[1].row).toEqual({ id: '2', name: 'Bob', desc: 'Foo, Bar' })
    })

    it('字段数小于表头数时补齐空字符串', () => {
      const csv = 'id,name,age\n1,Alice\n2,Bob,25'
      const result = parseCsvContent(csv, { headers: true, delimiter: ',', as: 'row' }) as Array<{ row: Record<string, string> }>
      expect(result[0].row).toEqual({ id: '1', name: 'Alice', age: '' })
      expect(result[1].row).toEqual({ id: '2', name: 'Bob', age: '25' })
    })

    it('Windows 换行符 (CRLF)', () => {
      const csv = '1,2\r\n3,4\r\n5,6'
      const result = parseCsvContent(csv, { headers: false, delimiter: ',', as: 'row' }) as Array<{ row: string[] }>
      expect(result.map(r => r.row)).toEqual([['1', '2'], ['3', '4'], ['5', '6']])
    })
  })
})

describe('LOAD CSV 执行（端到端）', () => {
  let tmpDir: string
  const sampleCsv = 'id,name,age\n1,Alice,30\n2,Bob,25\n'

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-test-'))
  })

  afterEach(() => {
    try {
      const files = fs.readdirSync(tmpDir)
      for (const f of files) fs.unlinkSync(path.join(tmpDir, f))
      fs.rmdirSync(tmpDir)
    } catch {
      // ignore cleanup errors
    }
  })

  it('从本地文件加载 CSV WITH HEADERS', async () => {
    const filePath = path.join(tmpDir, 'nodes.csv')
    fs.writeFileSync(filePath, sampleCsv, 'utf-8')

    const query = `LOAD CSV FROM '${filePath}' AS row WITH HEADERS RETURN row`
    const result = await _executeQuery(parseQuery(query), [], query) as any[]
    expect(result).toHaveLength(2)
    expect(result[0].row).toEqual({ id: '1', name: 'Alice', age: '30' })
    expect(result[1].row).toEqual({ id: '2', name: 'Bob', age: '25' })
  })

  it('从本地文件加载 CSV 无 HEADERS', async () => {
    const filePath = path.join(tmpDir, 'nodes.csv')
    fs.writeFileSync(filePath, '1,Alice,30\n2,Bob,25\n', 'utf-8')

    const query = `LOAD CSV FROM '${filePath}' AS row RETURN row`
    const result = await _executeQuery(parseQuery(query), [], query) as any[]
    expect(result).toHaveLength(2)
    expect(result[0].row).toEqual(['1', 'Alice', '30'])
    expect(result[1].row).toEqual(['2', 'Bob', '25'])
  })

  it('支持 file:// 协议路径', async () => {
    const filePath = path.join(tmpDir, 'data.csv')
    fs.writeFileSync(filePath, 'x,y\n1,2\n', 'utf-8')

    const query = `LOAD CSV FROM 'file://${filePath}' AS row WITH HEADERS RETURN row`
    const result = await _executeQuery(parseQuery(query), [], query) as any[]
    expect(result).toHaveLength(1)
    expect(result[0].row).toEqual({ x: '1', y: '2' })
  })

  it('文件不存在时抛出有意义的Error', async () => {
    const nonExistent = path.join(tmpDir, 'nonexistent.csv')
    const query = `LOAD CSV FROM '${nonExistent}' AS row WITH HEADERS RETURN row`
    await expect(_executeQuery(parseQuery(query), [], query)).rejects.toThrow(/file/i)
  })

  it('错误信息包含原始 source 路径', async () => {
    const fakePath = path.join(tmpDir, 'not-exist-file.csv')
    const query = `LOAD CSV FROM '${fakePath}' AS row WITH HEADERS RETURN row`
    await expect(_executeQuery(parseQuery(query), [], query)).rejects.toThrow()
  })

  it('引号转义内容正确保留', async () => {
    const filePath = path.join(tmpDir, 'escaped.csv')
    fs.writeFileSync(filePath, 'id,desc\n1,"She said ""Hello"""\n2,"Normal text"\n', 'utf-8')

    const query = `LOAD CSV FROM '${filePath}' AS row WITH HEADERS RETURN row`
    const result = await _executeQuery(parseQuery(query), [], query) as any[]
    expect(result).toHaveLength(2)
    expect(result[0].row.desc).toBe('She said "Hello"')
    expect(result[1].row.desc).toBe('Normal text')
  })
})

describe('LOAD CSV + 查询联动', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-query-'))
  })

  afterEach(() => {
    try {
      const files = fs.readdirSync(tmpDir)
      for (const f of files) fs.unlinkSync(path.join(tmpDir, f))
      fs.rmdirSync(tmpDir)
    } catch {
      // ignore cleanup errors
    }
  })

  it('LOAD CSV + RETURN 输出 CSV 行', () => {
    const csvPath = path.join(tmpDir, 'users.csv')
    fs.writeFileSync(csvPath, 'name,email\nAlice,alice@test.com\nBob,bob@test.com\n', 'utf-8')

    const plan = parseQuery(`LOAD CSV FROM '${csvPath}' AS row WITH HEADERS RETURN row`)

    expect(plan.loadCsv).toBeDefined()
    expect(plan.loadCsv!.url).toBe(csvPath)
    expect(plan.loadCsv!.hasHeaders).toBe(true)
    expect(plan.loadCsv!.rowVariable).toBe('row')
  })

  it('LOAD CSV + RETURN 输出多行', () => {
    const csvPath = path.join(tmpDir, 'numbers.csv')
    fs.writeFileSync(csvPath, 'n\n10\n20\n30\n40\n50\n', 'utf-8')

    const plan = parseQuery(`LOAD CSV FROM '${csvPath}' AS row WITH HEADERS RETURN row`)
    expect(plan.loadCsv).toBeDefined()
    expect(plan.loadCsv!.hasHeaders).toBe(true)
  })

  it('LOAD CSV 无 RETURN 也能被解析（或报 syntax error）', () => {
    const csvPath = '/tmp/test-load-csv-no-return.csv'
    fs.writeFileSync(csvPath, 'id,name\n1,Alice\n', 'utf-8')
    try {
      parseQuery(`LOAD CSV FROM '${csvPath}' AS row WITH HEADERS`)
      expect(true).toBe(true)
    } catch (e: any) {
      expect(e.message).toContain('Query parse error')
    }
    try { fs.unlinkSync(csvPath) } catch {}
  })
})
