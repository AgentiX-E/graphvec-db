// ============================================================
// OverGraphStorage — StorageProvider 的 OverGraph v0.7.0 实现
//
// 将 StorageProvider 接口适配到 OverGraph 原生 API。
// 这是 GraphEngine 的默认存储后端。
// ============================================================

import { OverGraph, OverGraphDB } from 'overgraph'
import { StorageProvider, StorageConfig, StorageStats, NeighborsOptions, NeighborEntry } from './storage-provider'
import {
  NodeId, UpsertNodeOptions, UpsertEdgeOptions,
} from '../types'

export class OverGraphStorage implements StorageProvider {
  private _db: OverGraphDB | null = null
  private _isOpen = false

  get isOpen(): boolean { return this._isOpen }

  open(config: StorageConfig): void {
    if (this._isOpen) return
    this._db = OverGraph.open(config.path, {
      denseVector: config.denseVector
        ? { dimension: config.denseVector.dimension }
        : undefined,
      defaultRetention: config.defaultRetention,
    })
    this._isOpen = true
  }

  close(): void {
    if (!this._isOpen || !this._db) return
    this._db.close()
    this._db = null
    this._isOpen = false
  }

  // ── 节点操作 ──────────────────────────────

  upsertNode(typeId: number, name: string, opts?: UpsertNodeOptions): NodeId {
    return this._db!.upsertNode(typeId, name, {
      props: opts?.props as Record<string, unknown> | undefined,
      denseVector: opts?.denseVector instanceof Float32Array
        ? opts.denseVector
        : opts?.denseVector ? new Float32Array(opts.denseVector) : undefined,
      sparseVector: opts?.sparseVector,
      temporalValidity: opts?.temporalValidity,
      decayFactor: opts?.decayFactor,
      retentionPolicy: opts?.ttlSeconds ? { ttlSeconds: opts.ttlSeconds } : undefined,
    })
  }

  getNode(id: NodeId, includeProps: boolean): {
    id: NodeId; typeId: number; key: string
    props?: Record<string, unknown>; createdAt: number
  } | null {
    const raw = this._db!.getNode(id, includeProps)
    if (!raw) return null
    return {
      id: raw.id,
      typeId: raw.typeId,
      key: raw.key,
      props: raw.props as Record<string, unknown> | undefined,
      createdAt: raw.createdAt,
    }
  }

  deleteNode(id: NodeId): boolean {
    this._db!.deleteNode(id)
    return true
  }

  batchUpsertNodes(inputs: Array<{
    typeId: number; name: string; key: string
    props?: Record<string, unknown>
    denseVector?: Float32Array
    temporalValidity?: { start?: number; end?: number }
  }>): NodeId[] {
    return this._db!.batchUpsertNodes(inputs)
  }

  degrees(id: NodeId): { inDegree: number; outDegree: number } {
    return this._db!.degrees(id)
  }

  // ── 边操作 ────────────────────────────────

  upsertEdge(src: NodeId, dst: NodeId, typeId: number, opts?: {
    props?: Record<string, unknown>
    temporalValidity?: { start?: number; end?: number }
    weight?: number
  }): void {
    this._db!.upsertEdge(src, dst, typeId, {
      props: opts?.props,
      temporalValidity: opts?.temporalValidity,
      weight: opts?.weight,
    })
  }

  getEdge(src: NodeId, dst: NodeId, typeId: number): {
    from: NodeId; to: NodeId; typeId: number
    props?: Record<string, unknown>; createdAt: number
  } | null {
    const raw = this._db!.getEdge(src, dst, typeId)
    if (!raw) return null
    return {
      from: raw.from,
      to: raw.to,
      typeId: raw.typeId,
      props: raw.props as Record<string, unknown> | undefined,
      createdAt: raw.createdAt,
    }
  }

  deleteEdge(src: NodeId, dst: NodeId, typeId: number): boolean {
    return this._db!.deleteEdge(src, dst, typeId)
  }

  neighbors(id: NodeId, opts?: NeighborsOptions): NeighborEntry[] {
    return this._db!.neighbors(id, { maxDepth: opts?.maxDepth ?? 1, edgeTypeFilter: opts?.edgeTypeFilter })
  }

  // ── 搜索 ──────────────────────────────────

  vectorSearch(searchQuery: string): Array<{ id: NodeId; score: number; distance: number }> {
    return this._db!.vectorSearch(searchQuery)
  }

  // ── 图算法 ────────────────────────────────

  personalizedPageRank(opts: {
    sourceNode: NodeId; maxIter: number; alpha: number; tolerance: number; topK: number
  }): { nodeId: NodeId; score: number }[] {
    return this._db!.personalizedPageRank(opts)
  }

  allShortestPaths(opts: {
    source: NodeId; target: NodeId; maxDepth: number
  }): { path: NodeId[]; cost: number }[] {
    return this._db!.allShortestPaths(opts)
  }

  connectedComponents(opts?: { edgeTypeFilter?: number[] }): NodeId[][] {
    return this._db!.connectedComponents(opts)
  }

  queryPattern(opts: {
    sourceNodeId?: NodeId; sourceTypeId?: number; depth: number
    edgeTypeFilter?: number[][]; nodeTypeFilter?: number[][]; limit: number
  }): Array<{ id: NodeId; typeId: number; key: string; props?: Record<string, unknown>; createdAt: number }> {
    return this._db!.queryPattern(opts).map(n => ({
      id: n.id, typeId: n.typeId, key: n.key,
      props: n.props as Record<string, unknown> | undefined,
      createdAt: n.createdAt,
    }))
  }

  // ── 维护 ──────────────────────────────────

  compact(): void {
    this._db!.compact()
  }

  stats(): StorageStats {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = this._db!.stats() as any
    return {
      nodeCount: s.activeNodeCount + s.immutableNodeCount,
      edgeCount: s.activeEdgeCount + s.immutableEdgeCount,
      diskSizeBytes: s.pendingWalBytes + s.activeMemtableBytes + s.immutableMemtableBytes,
      pendingWalBytes: s.pendingWalBytes,
      activeMemtableBytes: s.activeMemtableBytes,
      immutableMemtableBytes: s.immutableMemtableBytes,
    }
  }

  exportSnapshot(): Buffer {
    if (typeof (this._db as any).exportSnapshot !== 'function') {
      return Buffer.alloc(0)
    }
    return Buffer.from((this._db as any).exportSnapshot())
  }

  importSnapshot(data: Buffer): void {
    ;(this._db as any).importSnapshot(data)
  }
}
