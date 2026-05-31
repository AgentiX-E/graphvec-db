// ============================================================
// Importer — 流式批量导入器（CSV / NDJSON / ReadableStream）
// 支持批量写入 + 并发控制 + 进度报告
// ============================================================

import * as fs from 'node:fs'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { parse as csvParse } from 'csv-parse'

import type { GraphEngine } from '../core/graph-engine'
import type { UpsertNodeOptions, UpsertEdgeOptions, NodeId } from '../types'

// ──────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────

export type ImporterFormat = 'csv' | 'ndjson'

export interface ImporterCSVOptions {
  delimiter?: string
  batchSize?: number
  concurrency?: number
  onProgress?: ProgressCallback
}

export interface ImporterNDJSONOptions {
  batchSize?: number
  concurrency?: number
  onProgress?: ProgressCallback
}

export interface ImporterStreamOptions {
  batchSize?: number
  concurrency?: number
  onProgress?: ProgressCallback
}

export interface ImportProgress {
  totalRows: number
  importedRows: number
  failedRows: number
  errors: string[]
}

export type ProgressCallback = (progress: ImportProgress) => void

/** 导入行解析后的内部表示 */
interface RowRecord {
  type: 'node' | 'edge'
  typeId: number
  name?: string       // for nodes
  src?: string        // for edges
  dst?: string        // for edges
  props?: Record<string, unknown>
}

// ──────────────────────────────────────────
// 并发控制 — 简单的 promise 池
// ──────────────────────────────────────────

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const executing = new Set<Promise<void>>()

  for (let i = 0; i < items.length; i++) {
    const p = fn(items[i], i).finally(() => executing.delete(p))
    executing.add(p)

    if (executing.size >= concurrency) {
      await Promise.race(executing)
    }
  }

  // 等待所有剩余任务完成
  await Promise.all(Array.from(executing))
}

// ──────────────────────────────────────────
// Importer 类
// ──────────────────────────────────────────

export class Importer {
  private engine: GraphEngine

  constructor(engine: GraphEngine) {
    this.engine = engine
  }

  /**
   * 从 CSV 文件流式导入
   *
   * CSV 列格式:
   *   type, typeId, name/src, dst, props
   *
   *   node  行: node, <typeId>, <name>[, <props>]
   *   edge  行: edge, <typeId>, <src>, <dst>[, <props>]
   *
   * 第一行默认为表头，会被跳过。
   */
  async importCSV(
    filePath: string,
    options: ImporterCSVOptions = {},
  ): Promise<ImportProgress> {
    const {
      delimiter = ',',
      batchSize = 100,
      concurrency = 4,
      onProgress,
    } = options

    const readStream = createReadStream(filePath)
    return this.importStream(readStream, 'csv', {
      batchSize,
      concurrency,
      delimiter,
      onProgress,
    })
  }

  /**
   * 从 NDJSON 文件流式导入
   *
   * 每行 JSON 格式:
   *   { type: 'node', typeId: <number>, name: <string>[, props: {...}] }
   *   { type: 'edge', typeId: <number>, src: <string|number>, dst: <string|number>[, props: {...}] }
   */
  async importNDJSON(
    filePath: string,
    options: ImporterNDJSONOptions = {},
  ): Promise<ImportProgress> {
    const {
      batchSize = 100,
      concurrency = 4,
      onProgress,
    } = options

    const readStream = createReadStream(filePath)
    return this.importStream(readStream, 'ndjson', {
      batchSize,
      concurrency,
      onProgress,
    })
  }

  /**
   * 从任意 ReadableStream 导入
   *
   * @param readableStream - 可读流
   * @param format - 'csv' 或 'ndjson'
   * @param options.batchSize - 每批记录数（默认 100）
   * @param options.concurrency - 最大并行批次数（默认 4）
   * @param options.delimiter - CSV 分隔符（仅在 format='csv' 时有效）
   */
  async importStream(
    readableStream: NodeJS.ReadableStream,
    format: ImporterFormat,
    options: ImporterStreamOptions & { delimiter?: string } = {},
  ): Promise<ImportProgress> {
    const {
      batchSize = 100,
      concurrency = 4,
      delimiter = ',',
      onProgress,
    } = options

    const progress: ImportProgress = {
      totalRows: 0,
      importedRows: 0,
      failedRows: 0,
      errors: [],
    }

    if (format === 'csv') {
      await this._importCSVStream(readableStream, {
        delimiter,
        batchSize,
        concurrency,
      }, progress, onProgress)
    } else {
      await this._importNDJSONStream(readableStream, {
        batchSize,
        concurrency,
      }, progress, onProgress)
    }

    return progress
  }

  // ──────────────────────────────────────────
  // 内部：流式 CSV 导入
  // ──────────────────────────────────────────

  private async _importCSVStream(
    stream: NodeJS.ReadableStream,
    options: Required<Omit<ImporterStreamOptions & { delimiter: string }, never>>,
    progress: ImportProgress,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    const { delimiter, batchSize, concurrencyLimit } = {
      ...options,
      concurrencyLimit: options.concurrency ?? 4,
    }

    const parser = stream.pipe(
      csvParse({
        delimiter,
        from_line: 1, // Skip header — first line is data after header skip below
        relax_column_count: true,
        skip_empty_lines: true,
        // Disable quote parsing to avoid issues with JSON-stringified props
        quote: null,
        escape: null,
      }),
    )

    let isFirstLine = true
    let batch: RowRecord[] = []
    let flushInProgress: Promise<void> | null = null
    let drainResolve: (() => void) | null = null

    for await (const record of parser) {
      const cols = record as string[]
      if (cols.length < 2) continue

      // Skip header row (first line)
      if (isFirstLine) {
        isFirstLine = false
        const firstCol = cols[0].trim().toLowerCase()
        if (firstCol === 'type' || firstCol === 'typename') {
          continue
        }
      }

      const type = cols[0].trim().toLowerCase()

      let row: RowRecord | null = null

      try {
        if (type === 'node' || type === 'v') {
          const typeId = parseInt(cols[1]?.trim(), 10)
          if (isNaN(typeId)) throw new Error(`invalid typeId: ${cols[1]}`)
          const name = cols[2]?.trim() ?? ''
          if (!name) throw new Error('node requires a name')

          const props = cols[3]?.trim() ? this._safeParseProps(cols[3]) : undefined

          row = { type: 'node', typeId, name, props }
        } else if (type === 'edge' || type === 'e') {
          if (cols.length < 4) throw new Error('edge requires at least 4 columns')

          const typeId = parseInt(cols[1]?.trim(), 10)
          if (isNaN(typeId)) throw new Error(`invalid typeId: ${cols[1]}`)

          const src = cols[2]?.trim() ?? ''
          const dst = cols[3]?.trim() ?? ''
          if (!src || !dst) throw new Error('edge requires src and dst')

          const props = cols[4]?.trim() ? this._safeParseProps(cols[4]) : undefined

          row = { type: 'edge', typeId, src, dst, props }
        } else {
          progress.failedRows++
          progress.totalRows++
          progress.errors.push(`Row ${progress.totalRows}: unknown type "${type}"`)
          onProgress?.(snapshotProgress(progress))
          continue
        }
      } catch (err) {
        progress.failedRows++
        progress.totalRows++
        progress.errors.push(`Row ${progress.totalRows}: ${(err as Error).message}`)
        onProgress?.(snapshotProgress(progress))
        continue
      }

      if (row) {
        batch.push(row)
        progress.totalRows++
      }

      if (batch.length >= batchSize) {
        const batchToFlush = batch
        batch = []
        const flush = this._flushBatch(batchToFlush, concurrencyLimit).then((result) => {
          progress.importedRows += result.imported
          progress.failedRows += result.failed
          progress.errors.push(...result.errors)
          onProgress?.(snapshotProgress(progress))
          if (drainResolve) {
            drainResolve()
            drainResolve = null
          }
        })
        flushInProgress = flush

        // Backpressure: wait for current flush to complete before reading more
        // This prevents unbounded memory growth when the source is faster than
        // the consumer (e.g., a fast file read vs slow database writes).
        await flush
        flushInProgress = null
      }
    }

    // Wait for any in-flight flush to complete
    if (flushInProgress) {
      await flushInProgress
    }

    // Flush any remaining
    if (batch.length > 0) {
      const result = await this._flushBatch(batch, concurrencyLimit)
      progress.importedRows += result.imported
      progress.failedRows += result.failed
      progress.errors.push(...result.errors)
      onProgress?.(snapshotProgress(progress))
    }
  }

  // ──────────────────────────────────────────
  // 内部：流式 NDJSON 导入
  // ──────────────────────────────────────────

  private async _importNDJSONStream(
    stream: NodeJS.ReadableStream,
    options: Required<Omit<ImporterStreamOptions, never>>,
    progress: ImportProgress,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    const { batchSize, concurrency: concurrencyLimit } = options

    const rl = createInterface({
      input: stream,
      crlfDelay: Infinity,
    })

    let batch: RowRecord[] = []

    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) continue

      progress.totalRows++

      let row: RowRecord | null = null

      try {
        const parsed = JSON.parse(trimmed)

        if (!parsed.type || (parsed.type !== 'node' && parsed.type !== 'edge')) {
          throw new Error(`unrecognized type "${parsed.type}" (expected 'node' or 'edge')`)
        }

        const typeId = typeof parsed.typeId === 'number' ? parsed.typeId : parseInt(parsed.typeId, 10)
        if (isNaN(typeId)) throw new Error(`invalid typeId: ${parsed.typeId}`)

        if (parsed.type === 'node') {
          const name = parsed.name ?? parsed.id ?? ''
          if (!name) throw new Error('node requires a name')
          row = { type: 'node', typeId, name, props: parsed.props ?? undefined }
        } else {
          const src = parsed.src ?? parsed.source ?? parsed.from ?? ''
          const dst = parsed.dst ?? parsed.target ?? parsed.to ?? ''
          if (!src || !dst) throw new Error('edge requires src and dst')
          row = { type: 'edge', typeId, src: String(src), dst: String(dst), props: parsed.props ?? undefined }
        }
      } catch (err) {
        progress.failedRows++
        progress.errors.push(`Row ${progress.totalRows}: ${(err as Error).message}`)
        onProgress?.(snapshotProgress(progress))
        continue
      }

      if (row) {
        batch.push(row)
      }

      if (batch.length >= batchSize) {
        const batchToFlush = batch
        batch = []
        const result = await this._flushBatch(batchToFlush, concurrencyLimit)
        progress.importedRows += result.imported
        progress.failedRows += result.failed
        progress.errors.push(...result.errors)
        onProgress?.(snapshotProgress(progress))
      }
    }

    // Flush remaining
    if (batch.length > 0) {
      const result = await this._flushBatch(batch, concurrencyLimit)
      progress.importedRows += result.imported
      progress.failedRows += result.failed
      progress.errors.push(...result.errors)
      onProgress?.(snapshotProgress(progress))
    }
  }

  // ──────────────────────────────────────────
  // 批量写入（带并发控制）
  // ──────────────────────────────────────────

  private async _flushBatch(
    batch: RowRecord[],
    concurrency: number,
  ): Promise<{ imported: number; failed: number; errors: string[] }> {
    if (batch.length === 0) {
      return { imported: 0, failed: 0, errors: [] }
    }

    const result = { imported: 0, failed: 0, errors: [] as string[] }

    // 将批次分成多个子批次，每个子批次独立用 concurrency 并行写入
    // 由于 engine 的 batchUpsertNodes 是同步的，我们拆分 node/edge 后各自批次化

    const nodes = batch.filter((r): r is RowRecord & { type: 'node' } => r.type === 'node')
    const edges = batch.filter((r): r is RowRecord & { type: 'edge' } => r.type === 'edge')

    // 批量处理节点 — 使用 engine.batchUpsertNodes（同步批量）
    if (nodes.length > 0) {
      try {
        this.engine.batchUpsertNodes(
          nodes.map(n => ({
            typeId: n.typeId,
            name: n.name!,
            opts: n.props ? { props: n.props as any } : undefined,
          })),
        )
        result.imported += nodes.length
      } catch (err) {
        // 如果整个批次失败，单条回退
        for (const n of nodes) {
          try {
            await this.engine.upsertNode(n.typeId, n.name!, n.props ? { props: n.props as any } : undefined)
            result.imported++
          } catch (e) {
            result.failed++
            result.errors.push(`Node "${n.name}": ${(e as Error).message}`)
          }
        }
      }
    }

    // 批量处理边 — 使用并发池
    if (edges.length > 0) {
      await runWithConcurrency(edges, concurrency, async (e) => {
        try {
          const src = parseInt(e.src!, 10)
          const dst = parseInt(e.dst!, 10)

          // 如果 src/dst 是名称而非数字 ID，则 upsertNode 以获取 ID
          const srcId = isNaN(src)
            ? await this.engine.upsertNode(1, e.src!, { props: { _import_ref: e.src! } })
            : src
          const dstId = isNaN(dst)
            ? await this.engine.upsertNode(1, e.dst!, { props: { _import_ref: e.dst! } })
            : dst

          await this.engine.upsertEdge(srcId, dstId, e.typeId, e.props ? { props: e.props as any } : undefined)
          result.imported++
        } catch (err) {
          result.failed++
          result.errors.push(`Edge ${e.src} -> ${e.dst}: ${(err as Error).message}`)
        }
      })
    }

    return result
  }

  // ──────────────────────────────────────────
  // 辅助方法
  // ──────────────────────────────────────────

  /**
   * 安全解析 props JSON 字符串，失败时返回 undefined
   */
  private _safeParseProps(raw: string): Record<string, unknown> | undefined {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
}

/**
 * Create a snapshot of progress (shallow copy) for use in callbacks
 */
function snapshotProgress(p: ImportProgress): ImportProgress {
  return { ...p, errors: [...p.errors] }
}
