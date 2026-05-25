// ============================================================
// GraphImporter — 图数据导入器
// 支持 CSV / JSON / GraphSON / RDF 格式
// ============================================================

import { GraphEngine } from '../core/graph-engine'
import { NodeRecord, EdgeRecord, UpsertNodeOptions, UpsertEdgeOptions } from '../types'
import * as fs from 'fs'
import * as path from 'path'

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

// ──────────────────────────────────────────
// GraphImporter 类
// ──────────────────────────────────────────

export class GraphImporter {
  private engine: GraphEngine

  constructor(engine: GraphEngine) {
    this.engine = engine
  }

  /**
   * 导入文件
   */
  async importFile(options: ImportOptions): Promise<ImportResult> {
    const startTime = Date.now()
    const errors: string[] = []
    let nodesImported = 0
    let edgesImported = 0

    try {
      switch (options.format) {
        case 'csv':
          return this.importCSV(options)
        case 'json':
          return this.importJSON(options)
        case 'graphson':
          return this.importGraphSON(options)
        case 'rdf':
          return this.importRDF(options)
        default:
          throw new Error(`Unsupported format: ${options.format}`)
      }
    } catch (err) {
      errors.push(`Import failed: ${(err as Error).message}`)
    }

    return {
      nodesImported,
      edgesImported,
      errors,
      elapsedMs: Date.now() - startTime,
    }
  }

  // ──────────────────────────────────────────
  // CSV 导入
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
          await await this.engine.upsertNode(nodeType, name, opts)
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
          await await this.engine.upsertEdge(src, dst, edgeType, opts)
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
  // JSON 导入
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

    // 导入节点
    for (const node of nodes) {
      try {
        const nodeType = node.type ?? node.typeId ?? options.nodeType ?? 1
        const name = node.name ?? node.id?.toString() ?? `node-${nodesImported}`
        const opts: UpsertNodeOptions = {}
        if (node.props) opts.props = node.props
        await await this.engine.upsertNode(nodeType, name, opts)
        nodesImported++
      } catch (err) {
        errors.push(`Node import: ${(err as Error).message}`)
      }
    }

    // 导入边
    for (const edge of edges) {
      try {
        const src = edge.src ?? edge.source ?? edge.from
        const dst = edge.dst ?? edge.target ?? edge.to
        const edgeType = edge.type ?? edge.label ?? options.edgeType ?? 1
        const opts: UpsertEdgeOptions = {}
        if (edge.props) opts.props = edge.props
        await await this.engine.upsertEdge(src, dst, edgeType, opts)
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
          await await this.engine.upsertNode(nodeType, name, opts)
          nodesImported++
        } else if (el.type === 'edge') {
          const src = typeof el.outV === 'number' ? el.outV : parseInt(String(el.outV), 10)
          const dst = typeof el.inV === 'number' ? el.inV : parseInt(String(el.inV), 10)
          const edgeType = typeof el.label === 'number' ? el.label : 1
          await await this.engine.upsertEdge(src, dst, edgeType)
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
  // RDF 导入
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
        // Ensure subject node exists
        if (!subjectNodes.has(triple.subject)) {
          const nodeId = await await this.engine.upsertNode(1, triple.subject, {
            props: { rdf_uri: triple.subject },
          })
          subjectNodes.set(triple.subject, nodeId)
          nodesImported++
        }

        // Ensure object node exists (if not a literal)
        if (!triple.object.startsWith('"') && !objectNodes.has(triple.object)) {
          const nodeId = await await this.engine.upsertNode(1, triple.object, {
            props: { rdf_uri: triple.object },
          })
          objectNodes.set(triple.object, nodeId)
          nodesImported++
        }

        // Create edge between subject and object (if both are nodes)
        if (!triple.object.startsWith('"') && !triple.object.startsWith('_:')) {
          const srcId = subjectNodes.get(triple.subject)!
          const dstId = objectNodes.get(triple.object)!
          const edgeType = this.predicateToEdgeType(triple.predicate)
          await await this.engine.upsertEdge(srcId, dstId, edgeType)
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
  // 解析辅助
  // ──────────────────────────────────────────

  private parseNTriples(content: string): RDFTriple[] {
    const triples: RDFTriple[] = []

    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      // Simple N-Triples parser
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
