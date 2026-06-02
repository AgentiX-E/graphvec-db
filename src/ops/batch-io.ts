/**
 * 批量导入/导出工具
 *
 * 支持：
 *   - JSONL 批量导入（逐行解析，stream-compatible）
 *   - CSV 导入（header 自动映射到节点/边属性）
 *   - 导出到 JSONL / CSV
 *   - 进度回调
 */

import { NodeId, NodeProperties, NodeRecord, EdgeRecord } from '../types'
import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

export type ImportRow = NodeImportRow | EdgeImportRow

export interface NodeImportRow {
  type: 'node'
  id: NodeId
  name?: string
  props?: NodeProperties
}

export interface EdgeImportRow {
  type: 'edge'
  src: NodeId
  dst: NodeId
  weight?: number
  props?: NodeProperties
}

export interface BatchImportOptions {
  /** 数据文件路径（JSONL 或 CSV） */
  filePath: string
  /** 文件格式，默认 auto（从扩展名推断） */
  format?: 'jsonl' | 'csv'
  /** CSV 解析选项 */
  csvOptions?: CsvParseOptions
  /** 进度回调 */
  onProgress?: (processed: number, total: number) => void
  /** 错误回调 */
  onError?: (row: number, error: string) => void
  /** 跳过空行 */
  skipEmptyLines?: boolean
  /** 是否严格模式（遇到无效行直接抛错） */
  strict?: boolean
}

export interface BatchExportOptions {
  /** 输出文件路径 */
  filePath: string
  /** 文件格式 */
  format: 'jsonl' | 'csv'
  /** 数据行 */
  rows: ImportRow[]
  /** 进度回调 */
  onProgress?: (processed: number, total: number) => void
  /** CSV 导出选项 */
  csvOptions?: CsvWriteOptions
  /** 是否覆盖已有文件 */
  overwrite?: boolean
}

export interface CsvParseOptions {
  /** 分隔符，默认 ',' */
  delimiter?: string
  /** 是否包含 header，默认 true */
  hasHeader?: boolean
  /** 节点 ID 列名，默认 'id' */
  nodeIdColumn?: string
  /** 节点名称列名，默认 'name' */
  nodeNameColumn?: string
  /** 节点属性列名前缀，默认 'prop_' */
  propPrefix?: string
  /** 边源节点列名（edges），默认 'src' */
  edgeSrcColumn?: string
  /** 边目标节点列名（edges），默认 'dst' */
  edgeDstColumn?: string
  /** 边权重列名，默认 'weight' */
  edgeWeightColumn?: string
}

export interface CsvWriteOptions {
  /** 分隔符，默认 ',' */
  delimiter?: string
  /** 是否写入 header，默认 true */
  writeHeader?: boolean
  /** 是否引号包裹所有字段，默认 false */
  quoteAll?: boolean
}

export interface BatchImportResult {
  totalRows: number
  successRows: number
  errorRows: number
  nodes: NodeImportRow[]
  edges: EdgeImportRow[]
}

export interface BatchExportResult {
  totalRows: number
  filePath: string
  bytesWritten: number
}

// ──────────────────────────────────────────
// 默认配置
// ──────────────────────────────────────────

const DEFAULT_CSV_PARSE_OPTIONS: CsvParseOptions = {
  delimiter: ',',
  hasHeader: true,
  nodeIdColumn: 'id',
  nodeNameColumn: 'name',
  propPrefix: 'prop_',
  edgeSrcColumn: 'src',
  edgeDstColumn: 'dst',
  edgeWeightColumn: 'weight',
}

const DEFAULT_CSV_WRITE_OPTIONS: CsvWriteOptions = {
  delimiter: ',',
  writeHeader: true,
  quoteAll: false,
}

// ──────────────────────────────────────────
// Batch Import
// ──────────────────────────────────────────

/**
 * 批量导入节点和边数据
 *
 * @param options - 导入配置
 * @returns 导入结果
 */
export async function batchImport(options: BatchImportOptions): Promise<BatchImportResult> {
  const format = options.format ?? _detectFormat(options.filePath)
  const skipEmpty = options.skipEmptyLines ?? true

  if (format === 'jsonl') {
    return _importJSONL(options, skipEmpty)
  } else if (format === 'csv') {
    return _importCSV(options, skipEmpty)
  } else {
    throw new Error(`Unsupported format: ${format}. Use 'jsonl' or 'csv'.`)
  }
}

/**
 * 批量导出节点和边数据
 *
 * @param options - 导出配置
 * @returns 导出结果
 */
export async function batchExport(options: BatchExportOptions): Promise<BatchExportResult> {
  const { filePath, format, rows, csvOptions: csvOpt, onProgress, overwrite } = options

  // 检查文件存在
  if (!overwrite && fs.existsSync(filePath)) {
    throw new Error(`File already exists: ${filePath}. Set overwrite=true to override.`)
  }

  // 确保目录存在
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  if (format === 'jsonl') {
    return _exportJSONL(filePath, rows, onProgress)
  } else if (format === 'csv') {
    return _exportCSV(filePath, rows, csvOpt ?? DEFAULT_CSV_WRITE_OPTIONS, onProgress)
  } else {
    throw new Error(`Unsupported format: ${format}. Use 'jsonl' or 'csv'.`)
  }
}

// ──────────────────────────────────────────
// JSONL Import
// ──────────────────────────────────────────

async function _importJSONL(
  options: BatchImportOptions,
  skipEmpty: boolean,
): Promise<BatchImportResult> {
  const { filePath, onProgress, onError, strict } = options

  const nodes: NodeImportRow[] = []
  const edges: EdgeImportRow[] = []
  let totalRows = 0
  let successRows = 0
  let errorRows = 0

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity })

  for await (const line of rl) {
    totalRows++

    if (skipEmpty && line.trim() === '') {
      continue
    }

    try {
      const parsed = JSON.parse(line.trim())
      const row = _normalizeJSONLRow(parsed)

      if (row.type === 'node') {
        nodes.push(row)
      } else {
        edges.push(row)
      }

      successRows++
    } catch (err: any) {
      errorRows++
      if (onError) {
        onError(totalRows, err.message)
      }
      if (strict) {
        throw new Error(`Strict mode: error at row ${totalRows}: ${err.message}`)
      }
    }

    if (onProgress) {
      onProgress(successRows + errorRows, totalRows)
    }
  }

  return { totalRows, successRows, errorRows, nodes, edges }
}

function _normalizeJSONLRow(parsed: any): ImportRow {
  if (parsed.type === 'node') {
    return {
      type: 'node',
      id: Number(parsed.id),
      name: parsed.name ?? undefined,
      props: parsed.props ?? undefined,
    }
  }

  if (parsed.type === 'edge') {
    return {
      type: 'edge',
      src: Number(parsed.src),
      dst: Number(parsed.dst),
      weight: parsed.weight !== undefined ? Number(parsed.weight) : undefined,
      props: parsed.props ?? undefined,
    }
  }

  // 自动推断：如果有 src/dst 则是边，否则是节点
  if (parsed.src !== undefined && parsed.dst !== undefined) {
    return {
      type: 'edge',
      src: Number(parsed.src),
      dst: Number(parsed.dst),
      weight: parsed.weight !== undefined ? Number(parsed.weight) : undefined,
      props: parsed.props ?? undefined,
    }
  }

  return {
    type: 'node',
    id: Number(parsed.id),
    name: parsed.name ?? undefined,
    props: parsed.props ?? undefined,
  }
}

// ──────────────────────────────────────────
// CSV Import
// ──────────────────────────────────────────

async function _importCSV(
  options: BatchImportOptions,
  skipEmpty: boolean,
): Promise<BatchImportResult> {
  const csvOpt = { ...DEFAULT_CSV_PARSE_OPTIONS, ...options.csvOptions }
  const { filePath, onProgress, onError, strict } = options

  const nodes: NodeImportRow[] = []
  const edges: EdgeImportRow[] = []
  let totalRows = 0
  let successRows = 0
  let errorRows = 0

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity })

  let headers: string[] | null = null
  let lineNumber = 0

  for await (const line of rl) {
    lineNumber++

    if (skipEmpty && line.trim() === '') {
      continue
    }

    if (csvOpt.hasHeader && headers === null) {
      headers = _parseCSVLine(line, csvOpt.delimiter!)
      continue
    }

    totalRows++

    if (headers === null) {
      // hasHeader=false 时，生成列索引 header
      const fields = _parseCSVLine(line, csvOpt.delimiter!)
      headers = fields.map((_, i) => `col${i}`)
    }

    try {
      const fields = _parseCSVLine(line, csvOpt.delimiter!)
      const row = _mapCSVToRow(fields, headers!, csvOpt)
      if (row.type === 'node') {
        nodes.push(row)
      } else {
        edges.push(row)
      }
      successRows++
    } catch (err: any) {
      errorRows++
      if (onError) {
        onError(lineNumber, err.message)
      }
      if (strict) {
        throw new Error(`Strict mode: error at line ${lineNumber}: ${err.message}`)
      }
    }

    if (onProgress) {
      onProgress(successRows + errorRows, totalRows)
    }
  }

  return { totalRows, successRows, errorRows, nodes, edges }
}

function _mapCSVToRow(
  fields: string[],
  headers: string[],
  opts: CsvParseOptions,
): ImportRow {
  const map: Record<string, string> = {}
  for (let i = 0; i < headers.length && i < fields.length; i++) {
    map[headers[i]] = fields[i]
  }

  const hasSrc = opts.edgeSrcColumn! in map
  const hasDst = opts.edgeDstColumn! in map

  if (hasSrc && hasDst) {
    const edge: EdgeImportRow = {
      type: 'edge',
      src: Number(map[opts.edgeSrcColumn!]),
      dst: Number(map[opts.edgeDstColumn!]),
      weight: map[opts.edgeWeightColumn!] !== undefined ? Number(map[opts.edgeWeightColumn!]) : undefined,
      props: _extractProps(map, opts.propPrefix!),
    }
    return edge
  }

  const node: NodeImportRow = {
    type: 'node',
    id: map[opts.nodeIdColumn!] !== undefined ? Number(map[opts.nodeIdColumn!]) : 0,
    name: map[opts.nodeNameColumn!] ?? undefined,
    props: _extractProps(map, opts.propPrefix!),
  }
  return node
}

function _extractProps(map: Record<string, string>, prefix: string): NodeProperties | undefined {
  const props: NodeProperties = {}
  let found = false
  for (const [key, val] of Object.entries(map)) {
    if (key.startsWith(prefix)) {
      const propName = key.slice(prefix.length)
      props[propName] = _parseValue(val)
      found = true
    }
  }
  return found ? props : undefined
}

function _parseValue(val: string): string | number | boolean {
  if (val === 'true') return true
  if (val === 'false') return false
  const num = Number(val)
  if (!isNaN(num) && val.trim() !== '') return num
  return val
}

function _parseCSVLine(line: string, delimiter: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]

    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }

  result.push(current.trim())
  return result
}

// ──────────────────────────────────────────
// JSONL Export
// ──────────────────────────────────────────

async function _exportJSONL(
  filePath: string,
  rows: ImportRow[],
  onProgress?: (processed: number, total: number) => void,
): Promise<BatchExportResult> {
  const stream = fs.createWriteStream(filePath, { encoding: 'utf-8' })
  let bytesWritten = 0

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const json = JSON.stringify(row)
    const line = json + '\n'
    stream.write(line)
    bytesWritten += Buffer.byteLength(line, 'utf-8')

    if (onProgress && (i % 1000 === 0 || i === rows.length - 1)) {
      onProgress(i + 1, rows.length)
    }
  }

  await new Promise<void>((resolve) => stream.end(resolve))

  return { totalRows: rows.length, filePath, bytesWritten }
}

// ──────────────────────────────────────────
// CSV Export
// ──────────────────────────────────────────

async function _exportCSV(
  filePath: string,
  rows: ImportRow[],
  csvOpt: CsvWriteOptions,
  onProgress?: (processed: number, total: number) => void,
): Promise<BatchExportResult> {
  const delimiter = csvOpt.delimiter ?? ','
  const stream = fs.createWriteStream(filePath, { encoding: 'utf-8' })
  let bytesWritten = 0

  // 收集所有可能的列
  const allProps = _collectProps(rows)
  const nodeColumns = ['type', 'id', 'name', ...allProps.map((p) => `${DEFAULT_CSV_PARSE_OPTIONS.propPrefix}${p}`)]
  const edgeColumns = ['type', 'src', 'dst', 'weight', ...allProps.map((p) => `${DEFAULT_CSV_PARSE_OPTIONS.propPrefix}${p}`)]

  if (csvOpt.writeHeader !== false) {
    const headerLine = nodeColumns.join(delimiter) + '\n'
    stream.write(headerLine)
    bytesWritten += Buffer.byteLength(headerLine, 'utf-8')
  }

  let writeCount = 0
  for (const row of rows) {
    const fields: string[] = []

    if (row.type === 'node') {
      fields.push('node')
      fields.push(String(row.id))
      fields.push(row.name ?? '')
      for (const prop of allProps) {
        fields.push(_formatCSVField(row.props?.[prop], delimiter, csvOpt.quoteAll))
      }
    } else {
      fields.push('edge')
      fields.push(String(row.src))
      fields.push(String(row.dst))
      fields.push(row.weight !== undefined ? String(row.weight) : '')
      for (const prop of allProps) {
        fields.push(_formatCSVField(row.props?.[prop], delimiter, csvOpt.quoteAll))
      }
    }

    const line = fields.join(delimiter) + '\n'
    stream.write(line)
    bytesWritten += Buffer.byteLength(line, 'utf-8')
    writeCount++

    if (onProgress && (writeCount % 1000 === 0 || writeCount === rows.length)) {
      onProgress(writeCount, rows.length)
    }
  }

  await new Promise<void>((resolve) => stream.end(resolve))

  return { totalRows: rows.length, filePath, bytesWritten }
}

function _collectProps(rows: ImportRow[]): string[] {
  const propSet = new Set<string>()
  for (const row of rows) {
    if (row.props) {
      for (const key of Object.keys(row.props)) {
        propSet.add(key)
      }
    }
  }
  return Array.from(propSet)
}

function _formatCSVField(
  value: string | number | boolean | null | string[] | number[] | undefined,
  delimiter: string,
  quoteAll?: boolean,
): string {
  if (value === undefined || value === null) return ''

  const str = String(value)
  const needsQuote = quoteAll || str.includes(delimiter) || str.includes('"') || str.includes('\n')

  if (needsQuote) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

function _detectFormat(filePath: string): 'jsonl' | 'csv' {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl'
  if (ext === '.csv') return 'csv'
  throw new Error(`Cannot detect format from extension: ${filePath}. Use .jsonl, .ndjson, or .csv`)
}
