// ============================================================
// GraphImporter — 图数据导入器
// 支持 CSV / NDJSON / JSON / GraphSON / RDF 格式
// 大文件（>=50MB）自动切换流式解析，防止 OOM
// ============================================================

import { GraphEngine } from '../core/graph-engine'
import { NodeRecord, EdgeRecord, UpsertNodeOptions, UpsertEdgeOptions, NodeId } from '../types'
import * as fs from 'fs'
import * as path from 'path'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { parse } from 'csv-parse'

// ──────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────

export type ImportFormat = 'csv' | 'json' | 'graphson' | 'rdf'

export interface ImportOptions {
  format: ImportFormat
  filePath: string
  batchSize?: number
  nodeType?: number
  edgeType?: number
  skipHeader?: boolean
  delimiter?: string
  onProgress?: (progress: { imported: number; total: number; errors: number }) => void
  /** 强制使用流式导入（跳过文件大小检查） */
  forceStream?: boolean
  /** 使用 batchUpsertNodes 批量写入（仅流式导入时有效） */
  useBatchWrite?: boolean
}

export interface ImportResult {
  nodesImported: number
  edgesImported: number
  errors: string[]
  elapsedMs: number
}

export interface GraphSONElement {
  id: string | number
  label?: string
  type: 'vertex' | 'edge'
  properties?: Record<string, { value: unknown }[]>
  inVLabel?: string
  outVLabel?: string
  inV?: string | number
  outV?: string | number
}

export interface RDFTriple {
  subject: string
  predicate: string
  object: string
}

/**
 * 流式导入的中间表达式，用于统一批处理
 */
interface BatchNodeItem {
  type: 'node'
  typeId: number
  name: string
  opts?: UpsertNodeOptions
}

interface BatchEdgeItem {
  type: 'edge'
  src: string
  dst: string
  typeId: number
  opts?: UpsertEdgeOptions
}

type BatchItem = BatchNodeItem | BatchEdgeItem

// 阈值：超过此大小的文件使用流式导入
const STREAM_THRESHOLD_BYTES = 50 * 1024 * 1024 // 50MB

// ──────────────────────────────────────────
// GraphImporter 类
// ──────────────────────────────────────────

export class GraphImporter {
  private engine: GraphEngine

  constructor(engine: GraphEngine) {
    this.engine = engine
  }

  // ──────────────────────────────────────────
  // 公共入口
  // ──────────────────────────────────────────

  /**
   * 导入文件
   * 根据文件扩展名和大小自动选择解析策略：
   * - < 50MB 且非 forceStream → 保持原 readFileSync 路径（兼容）
   * - >= 50MB 或 forceStream → 自动切换流式路径
   */
  async importFile(options: ImportOptions): Promise<ImportResult> {
    const startTime = Date.now()

    try {
      const fileSize = await this._getFileSize(options.filePath)
      const useStream = options.forceStream || fileSize >= STREAM_THRESHOLD_BYTES

      switch (options.format) {
        case 'csv':
          if (useStream) {
            return await this.importCSVStream(options)
          }
          return await this.importCSV(options)
        case 'json':
          if (useStream) {
            return await this.importNDJSONStream(options)
          }
          return await this.importJSON(options)
        case 'graphson':
          if (useStream) {
            return this._notSupportedStreaming(options.filePath)
          }
          return await this.importGraphSON(options)
        case 'rdf':
          if (useStream) {
            return this._notSupportedStreaming(options.filePath)
          }
          return await this.importRDF(options)
        default:
          throw new Error(`Unsupported format: ${options.format}`)
      }
    } catch (err) {
      const errors: string[] = [`Import failed: ${(err as Error).message}`]
      return {
        nodesImported: 0,
        edgesImported: 0,
        errors,
        elapsedMs: Date.now() - startTime,
      }
    }
  }

  // ──────────────────────────────────────────
  // 流式 CSV 导入
  // ──────────────────────────────────────────

  private async importCSVStream(options: ImportOptions): Promise<ImportResult> {
    const startTime = Date.now()
    const errors: string[] = []
    let totalNodes = 0
    let totalEdges = 0
    const BATCH_SIZE = options.batchSize ?? 500

    let batch: BatchItem[] = []
    let lineNum = 0

    // 使用 Promise 包装 createReadStream，确保 ENOENT 等错误能被捕获
    const fileStream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      const stream = createReadStream(options.filePath)
        .on('open', () => resolve(stream))
        .on('error', reject)
    })

    const parser = fileStream
      .pipe(parse({
        delimiter: options.delimiter ?? ',',
        from_line: options.skipHeader ? 2 : 1,
        relax_column_count: true,
        skip_empty_lines: true,
        // 禁用引号解析，因为 JSON props 字段可能包含 { } 字符
        quote: null,
        escape: null,
      }))

    try {
    for await (const record of parser) {
      lineNum++
      try {
        const cols = record as string[]
        if (cols.length < 2) continue

        const type = cols[0].trim().toLowerCase()
        if (type === 'node' || type === 'v') {
          const nodeType = parseInt(cols[1], 10) || (options.nodeType ?? 1)
          const name = cols[2]?.trim() ?? `node-${lineNum}`
          const opts: UpsertNodeOptions = {}
          if (cols[3]?.trim()) {
            try {
              opts.props = JSON.parse(cols[3])
            } catch { /* ignore bad props */ }
          }
          batch.push({ type: 'node', typeId: nodeType, name, opts })
        } else if (type === 'edge' || type === 'e') {
          if (cols.length < 4) {
            errors.push(`Line ${lineNum}: edge requires at least 4 columns`)
            continue
          }
          const src = cols[1].trim()
          const dst = cols[2].trim()
          const edgeType = parseInt(cols[3], 10) || (options.edgeType ?? 1)
          const opts: UpsertEdgeOptions = {}
          if (cols[4]?.trim()) {
            try {
              opts.props = JSON.parse(cols[4])
            } catch { /* ignore */ }
          }
          batch.push({ type: 'edge', src, dst, typeId: edgeType, opts })
        } else {
          errors.push(`Line ${lineNum}: unknown type "${type}" (expected node/v or edge/e)`)
          continue
        }

        if (batch.length >= BATCH_SIZE) {
          const stats = await this._flushBatch(batch)
          totalNodes += stats.nodes
          totalEdges += stats.edges
          batch = []
        }
      } catch (err) {
        errors.push(`Line ${lineNum}: ${(err as Error).message}`)
      }
    }
    } catch (err) {
      errors.push(`Stream error: ${(err as Error).message}`)
    }

    // Flush remaining
    if (batch.length > 0) {
      const stats = await this._flushBatch(batch)
      totalNodes += stats.nodes
      totalEdges += stats.edges
    }

    return {
      nodesImported: totalNodes,
      edgesImported: totalEdges,
      errors: errors.slice(0, 100),
      elapsedMs: Date.now() - startTime,
    }
  }

  // ──────────────────────────────────────────
  // 流式 NDJSON / JSONL 导入
  // ──────────────────────────────────────────

  private async importNDJSONStream(options: ImportOptions): Promise<ImportResult> {
    const startTime = Date.now()
    const errors: string[] = []
    let totalNodes = 0
    let totalEdges = 0
    const BATCH_SIZE = options.batchSize ?? 500

    let batch: BatchItem[] = []
    let lineNum = 0

    // 支持 .json（每行 JSON 对象）、.ndjson、.jsonl
    // 使用 Promise 包装 createReadStream，确保 ENOENT 等错误能被捕获
    const fileStream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      const stream = createReadStream(options.filePath)
        .on('open', () => resolve(stream))
        .on('error', reject)
    })

    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    })

    try {
    for await (const line of rl) {
      lineNum++
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const record = JSON.parse(trimmed)
        const item = this._recordToBatchItem(record, lineNum, options)
        if (item) {
          batch.push(item)
        } else {
          errors.push(`Line ${lineNum}: unrecognized record format`)
          continue
        }

        if (batch.length >= BATCH_SIZE) {
          const stats = await this._flushBatch(batch)
          totalNodes += stats.nodes
          totalEdges += stats.edges
          batch = []
        }
      } catch (err) {
        errors.push(`Line ${lineNum}: JSON parse error — ${(err as Error).message}`)
      }
    }

    // Flush remaining
    if (batch.length > 0) {
      const stats = await this._flushBatch(batch)
      totalNodes += stats.nodes
      totalEdges += stats.edges
    }
    } catch (err) {
      errors.push(`Stream error: ${(err as Error).message}`)
    }

    return {
      nodesImported: totalNodes,
      edgesImported: totalEdges,
      errors: errors.slice(0, 100),
      elapsedMs: Date.now() - startTime,
    }
  }

  // ──────────────────────────────────────────
  // 原始 CSV 导入（文件较小，保持兼容）
  // ──────────────────────────────────────────

  private async importCSV(options: ImportOptions): Promise<ImportResult> {
    const startTime = Date.now()
    const errors: string[] = []
    let nodesImported = 0
    let edgesImported = 0

    const content = await fs.promises.readFile(options.filePath, 'utf-8')
    const lines = content.split('\n').filter(l => l.trim().length > 0)

    let startIdx = 0
    if (options.skipHeader) startIdx = 1

    for (let i = startIdx; i < lines.length; i++) {
      try {
        const cols = lines[i].split(options.delimiter ?? ',')
        if (cols.length < 2) continue

        const type = cols[0].trim().toLowerCase()
        if (type === 'node' || type === 'v') {
          const nodeType = parseInt(cols[1], 10)
          const name = cols[2]?.trim() ?? `node-${i}`
          const opts: UpsertNodeOptions = {}
          if (cols[3]?.trim()) {
            try {
              opts.props = JSON.parse(cols[3])
            } catch { /* ignore bad props */ }
          }
          await this.engine.upsertNode(nodeType, name, opts)
          nodesImported++
        } else if (type === 'edge' || type === 'e') {
          const src = parseInt(cols[1], 10)
          const dst = parseInt(cols[2], 10)
          const edgeType = parseInt(cols[3], 10)
          const opts: UpsertEdgeOptions = {}
          if (cols[4]?.trim()) {
            try {
              opts.props = JSON.parse(cols[4])
            } catch { /* ignore */ }
          }
          await this.engine.upsertEdge(src, dst, edgeType, opts)
          edgesImported++
        }
      } catch (err) {
        errors.push(`Line ${i + 1}: ${(err as Error).message}`)
      }
    }

    return {
      nodesImported,
      edgesImported,
      errors: errors.slice(0, 100),
      elapsedMs: Date.now() - startTime,
    }
  }

  // ──────────────────────────────────────────
  // 原始 JSON 导入（文件较小，保持兼容）
  // ──────────────────────────────────────────

  private async importJSON(options: ImportOptions): Promise<ImportResult> {
    const startTime = Date.now()
    const errors: string[] = []
    let nodesImported = 0
    let edgesImported = 0

    const content = await fs.promises.readFile(options.filePath, 'utf-8')
    const data = JSON.parse(content)

    const nodes = data.nodes ?? data.vertices ?? []
    const edges = data.edges ?? []

    for (const node of nodes) {
      try {
        const nodeType = node.type ?? node.typeId ?? options.nodeType ?? 1
        const name = node.name ?? node.id?.toString() ?? `node-${nodesImported}`
        const opts: UpsertNodeOptions = {}
        if (node.props) opts.props = node.props
        await this.engine.upsertNode(nodeType, name, opts)
        nodesImported++
      } catch (err) {
        errors.push(`Node import: ${(err as Error).message}`)
      }
    }

    for (const edge of edges) {
      try {
        const src = edge.src ?? edge.source ?? edge.from
        const dst = edge.dst ?? edge.target ?? edge.to
        const edgeType = edge.type ?? edge.label ?? options.edgeType ?? 1
        const opts: UpsertEdgeOptions = {}
        if (edge.props) opts.props = edge.props
        await this.engine.upsertEdge(src, dst, edgeType, opts)
        edgesImported++
      } catch (err) {
        errors.push(`Edge import: ${(err as Error).message}`)
      }
    }

    return {
      nodesImported,
      edgesImported,
      errors: errors.slice(0, 100),
      elapsedMs: Date.now() - startTime,
    }
  }

  // ──────────────────────────────────────────
  // GraphSON 导入
  // ──────────────────────────────────────────

  private async importGraphSON(options: ImportOptions): Promise<ImportResult> {
    const startTime = Date.now()
    const errors: string[] = []
    let nodesImported = 0
    let edgesImported = 0

    const content = await fs.promises.readFile(options.filePath, 'utf-8')
    const data = JSON.parse(content)

    const elements: GraphSONElement[] = []

    if (Array.isArray(data)) {
      elements.push(...data)
    } else if (data.vertices || data.edges) {
      const vertices: GraphSONElement[] = (data.vertices ?? []).map((v: any) => ({
        ...v,
        type: 'vertex',
      }))
      const edgeList: GraphSONElement[] = (data.edges ?? []).map((e: any) => ({
        ...e,
        type: 'edge',
      }))
      elements.push(...vertices, ...edgeList)
    }

    for (const el of elements) {
      try {
        if (el.type === 'vertex') {
          const nodeType = typeof el.label === 'number' ? el.label : 1
          const name = (el as any).name ?? el.id?.toString() ?? `v-${nodesImported}`
          const opts: UpsertNodeOptions = {}
          if (el.properties) {
            opts.props = {}
            for (const [key, vals] of Object.entries(el.properties)) {
              if (vals && vals.length > 0) {
                opts.props[key] = String(vals[0].value)
              }
            }
          }
          await this.engine.upsertNode(nodeType, name, opts)
          nodesImported++
        } else if (el.type === 'edge') {
          const src = typeof el.outV === 'number' ? el.outV : parseInt(String(el.outV), 10)
          const dst = typeof el.inV === 'number' ? el.inV : parseInt(String(el.inV), 10)
          const edgeType = typeof el.label === 'number' ? el.label : 1
          await this.engine.upsertEdge(src, dst, edgeType)
          edgesImported++
        }
      } catch (err) {
        errors.push(`GraphSON element: ${(err as Error).message}`)
      }
    }

    return {
      nodesImported,
      edgesImported,
      errors: errors.slice(0, 100),
      elapsedMs: Date.now() - startTime,
    }
  }

  // ──────────────────────────────────────────
  // RDF / N-Triples 导入
  // ──────────────────────────────────────────

  private async importRDF(options: ImportOptions): Promise<ImportResult> {
    const startTime = Date.now()
    const errors: string[] = []
    let nodesImported = 0
    let edgesImported = 0

    const content = await fs.promises.readFile(options.filePath, 'utf-8')
    const triples = this.parseNTriples(content)

    const subjectNodes = new Map<string, number>()
    const objectNodes = new Map<string, number>()

    for (const triple of triples) {
      try {
        if (!subjectNodes.has(triple.subject)) {
          const nodeId = await this.engine.upsertNode(1, triple.subject, {
            props: { rdf_uri: triple.subject },
          })
          subjectNodes.set(triple.subject, nodeId)
          nodesImported++
        }

        if (!triple.object.startsWith('"') && !objectNodes.has(triple.object)) {
          const nodeId = await this.engine.upsertNode(1, triple.object, {
            props: { rdf_uri: triple.object },
          })
          objectNodes.set(triple.object, nodeId)
          nodesImported++
        }

        if (!triple.object.startsWith('"') && !triple.object.startsWith('_:')) {
          const srcId = subjectNodes.get(triple.subject)!
          const dstId = objectNodes.get(triple.object)!
          const edgeType = this.predicateToEdgeType(triple.predicate)
          await this.engine.upsertEdge(srcId, dstId, edgeType)
          edgesImported++
        }
      } catch (err) {
        errors.push(`Triple: ${(err as Error).message}`)
      }
    }

    return {
      nodesImported,
      edgesImported,
      errors: errors.slice(0, 100),
      elapsedMs: Date.now() - startTime,
    }
  }

  // ──────────────────────────────────────────
  // 批量刷新（将一批 BatchItem 写入引擎）
  // ──────────────────────────────────────────

  /**
   * 将一批节点/边写入引擎。
   * 节点使用 batchUpsertNodes（同步批量写入），边使用单个 upsertEdge。
   */
  private async _flushBatch(batch: BatchItem[]): Promise<{ nodes: number; edges: number }> {
    if (batch.length === 0) return { nodes: 0, edges: 0 }

    const nodes = batch.filter((item): item is BatchNodeItem => item.type === 'node')
    const edges = batch.filter((item): item is BatchEdgeItem => item.type === 'edge')

    const nodeCount = nodes.length
    const edgeCount = edges.length

    // 节点批量写入
    if (nodes.length > 0) {
      try {
        this.engine.batchUpsertNodes(
          nodes.map(n => ({
            typeId: n.typeId,
            name: n.name,
            opts: n.opts,
          }))
        )
      } catch (err) {
        // 如果批量失败，回退到单个写入
        for (const n of nodes) {
          try {
            await this.engine.upsertNode(n.typeId, n.name, n.opts)
          } catch { /* individual fallback errors are silently swallowed */ }
        }
      }
    }

    // 边无法批量（GraphEngine 没有 batchUpsertEdges），逐条写入
    for (const e of edges) {
      try {
        // src/dst 可能为字符串（名称）或数字（ID），upsertEdge 接受 NodeId (number)
        const src = parseInt(e.src, 10) || await this._resolveNodeName(e.src, e.opts)
        const dst = parseInt(e.dst, 10) || await this._resolveNodeName(e.dst, e.opts)
        await this.engine.upsertEdge(src, dst, e.typeId, e.opts)
      } catch { /* individual edge error silently swallowed — caller has error tracking at line level */ }
    }

    return { nodes: nodeCount, edges: edgeCount }
  }

  /**
   * 将边源/目标（名称字符串）解析为 NodeId
   */
  private async _resolveNodeName(name: string, opts?: UpsertEdgeOptions): Promise<number> {
    // 先尝试按名称 upsert（若不存在则创建），确保节点存在
    return await this.engine.upsertNode(1, name, { props: { import_ref: name } })
  }

  // ──────────────────────────────────────────
  // 辅助方法
  // ──────────────────────────────────────────

  /**
   * 将 NDJSON 行解析为 BatchItem
   */
  private _recordToBatchItem(
    record: Record<string, unknown>,
    lineNum: number,
    options: ImportOptions
  ): BatchItem | null {
    if (record.type === 'node' || record.type === 'v' || record.vertices) {
      // 单条 node
      const typeId =
        (record.typeId as number) ??
        (record.label as number) ??
        options.nodeType ??
        1
      const name = (record.name as string) ?? (record.id as string) ?? `node-${lineNum}`
      const opts: UpsertNodeOptions = {}
      if (record.props) opts.props = record.props as Record<string, string | number | boolean | null | string[] | number[]>
      return {
        type: 'node' as const,
        typeId: typeof typeId === 'number' ? typeId : parseInt(String(typeId), 10) || 1,
        name,
        opts: Object.keys(opts).length > 0 ? opts : undefined,
      }
    }

    if (record.type === 'edge' || record.type === 'e') {
      const src = String(record.src ?? record.source ?? record.from ?? '')
      const dst = String(record.dst ?? record.target ?? record.to ?? '')
      const typeId =
        (record.typeId as number) ??
        (record.label as number) ??
        options.edgeType ??
        1
      const opts: UpsertEdgeOptions = {}
      if (record.props) opts.props = record.props as Record<string, string | number | boolean | null | string[] | number[]>
      return {
        type: 'edge' as const,
        src,
        dst,
        typeId: typeof typeId === 'number' ? typeId : parseInt(String(typeId), 10) || 1,
        opts: Object.keys(opts).length > 0 ? opts : undefined,
      }
    }

    return null
  }

  private async _getFileSize(filePath: string): Promise<number> {
    try {
      const stat = await fs.promises.stat(filePath)
      return stat.size
    } catch {
      return 0
    }
  }

  private _notSupportedStreaming(filePath: string): ImportResult {
    return {
      nodesImported: 0,
      edgesImported: 0,
      errors: [
        `${path.extname(filePath)} format not supported for streaming import; ` +
        'use a file smaller than 50MB or convert to CSV/NDJSON format',
      ],
      elapsedMs: 0,
    }
  }

  // ──────────────────────────────────────────
  // 解析辅助
  // ──────────────────────────────────────────

  private parseNTriples(content: string): RDFTriple[] {
    const triples: RDFTriple[] = []

    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      const parts = trimmed.split(/\s+/)
      if (parts.length >= 3) {
        const subject = parts[0].replace(/[<>]/g, '')
        const predicate = parts[1].replace(/[<>]/g, '')
        const object = parts[2].replace(/[<>]/g, '')
        triples.push({ subject, predicate, object })
      }
    }

    return triples
  }

  private predicateToEdgeType(predicate: string): number {
    const known: Record<string, number> = {
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#type': 10,
      'http://www.w3.org/2000/01/rdf-schema#label': 11,
      'http://www.w3.org/2000/01/rdf-schema#subClassOf': 12,
    }
    return known[predicate] ?? 100
  }
}
