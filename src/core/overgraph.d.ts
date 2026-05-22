// OverGraph v0.7.0 — Native Module Type Declarations
// Verified against runtime behavior on Node v24.14.0
// OverGraph is an embedded Rust graph database via napi-rs bindings.

declare module 'overgraph' {
  // ───────────────────────────
  // Node operations
  // ───────────────────────────
  export interface NodeOp {
    typeId: number
    name: string
    props?: Record<string, unknown>
    denseVector?: Float32Array
    sparseVector?: Record<number, number>
    temporalValidity?: { start?: number; end?: number }
    decayFactor?: number
    retentionPolicy?: { ttlSeconds: number }
  }

  export interface JsNodeRecord {
    /** Node ID (auto-incremented) */
    readonly id: number
    /** Node type ID (the `typeId` passed to upsertNode) */
    readonly typeId: number
    /** Node name (stored as `key` internally) */
    readonly key: string
    /** Custom properties */
    readonly props: Record<string, unknown>
    readonly weight: number
    readonly createdAt: number
    readonly updatedAt: number
  }

  // ───────────────────────────
  // Edge operations
  // ───────────────────────────
  export interface EdgeOp {
    src: number
    dst: number
    typeId: number
    props?: Record<string, unknown>
    temporalValidity?: { start?: number; end?: number }
    weight?: number
  }

  export interface JsEdgeRecord {
    readonly id: number
    readonly from: number
    readonly to: number
    readonly typeId: number
    readonly props: Record<string, unknown>
    readonly weight: number
    readonly createdAt: number
    readonly updatedAt: number
    readonly validFrom: number
    readonly validTo: number
  }

  // ───────────────────────────
  // Neighbors
  // ───────────────────────────
  export interface NeighborEntry {
    nodeId: number
    edgeId: number
    edgeTypeId: number
    weight: number
    validFrom: number
    validTo: number
  }

  // ───────────────────────────
  // Vector search
  // ───────────────────────────
  export interface VectorSearchQuery {
    denseQuery?: Float32Array | number[]
    sparseQuery?: Record<number, number>
    k?: number
    hybrid?: boolean
    /** JSON string for hybrid weights */
    hybridWeights?: string
    scope?: {
      startNodeId?: number
      maxDepth?: number
      edgeTypeFilter?: number[]
    }
    minScore?: number
  }

  export interface VectorSearchHit {
    id: number
    score: number
    distance: number
  }

  // ───────────────────────────
  // Graph algorithms
  // ───────────────────────────
  export interface PPROptions {
    sourceNode: number
    maxIter?: number
    alpha?: number
    tolerance?: number
    topK?: number
  }

  export interface ShortestPathOpts {
    source: number
    target: number
    maxDepth?: number
    maxPaths?: number
    edgeTypeFilter?: number[]
  }

  export interface ConnectedComponentsOpts {
    edgeTypeFilter?: number[]
    minSize?: number
  }

  export interface PatternOpts {
    sourceNodeId?: number
    sourceTypeId?: number
    depth?: number
    edgeTypeFilter?: number[][]
    nodeTypeFilter?: number[][]
    limit?: number
  }

  export interface StorageStats {
    pendingWalBytes: number
    segmentCount: number
    nodeTombstoneCount: number
    edgeTombstoneCount: number
    walSyncMode: string
    activeMemtableBytes: number
    immutableMemtableBytes: number
    immutableMemtableCount: number
    pendingFlushCount: number
    activeWalGenerationId: number
    oldestRetainedWalGenerationId: number
  }

  export interface DBOptions {
    path: string
    denseVector?: { dimension: number }
    defaultRetention?: { nodes?: string; edges?: string }
  }

  export interface OverGraphDB {
    close(): void
    upsertNode(typeId: number, name: string, opts?: Partial<NodeOp>): number
    getNode(id: number, includeProps?: boolean): JsNodeRecord | null
    deleteNode(id: number): boolean
    batchUpsertNodes(inputs: Partial<NodeOp>[]): number[]
    upsertEdge(src: number, dst: number, typeId: number, opts?: Partial<EdgeOp>): void
    getEdge(from: number, to: number, typeId: number): JsEdgeRecord | null
    deleteEdge(from: number, to: number, typeId: number): boolean
    neighbors(id: number, opts?: { maxDepth?: number; edgeTypeFilter?: number[] }): NeighborEntry[]
    neighborsBatch(ids: number[], opts?: { maxDepth?: number; edgeTypeFilter?: number[] }): NeighborEntry[][]
    vectorSearch(query: string | VectorSearchQuery): VectorSearchHit[]
    personalizedPageRank(opts: PPROptions): { nodeId: number; score: number }[]
    allShortestPaths(opts: ShortestPathOpts): { path: number[]; cost: number }[]
    connectedComponents(opts?: ConnectedComponentsOpts): number[][]
    degrees(id: number): { inDegree: number; outDegree: number }
    queryPattern(opts: PatternOpts): JsNodeRecord[]
    compact(): void
    stats(): StorageStats
    exportSnapshot(): Uint8Array
    importSnapshot(data: Uint8Array): void
  }

  export class OverGraph {
    constructor()
    /** Factory method: opens a database at the specified path (preferred) */
    static open(path: string, opts?: Partial<DBOptions>): OverGraphDB
    open(opts: DBOptions): void
    close(): void
    upsertNode(typeId: number, name: string, opts?: Partial<NodeOp>): number
    getNode(id: number, includeProps?: boolean): JsNodeRecord | null
    deleteNode(id: number): boolean
    batchUpsertNodes(inputs: Partial<NodeOp>[]): number[]
    upsertEdge(src: number, dst: number, typeId: number, opts?: Partial<EdgeOp>): void
    getEdge(from: number, to: number, typeId: number): JsEdgeRecord | null
    deleteEdge(from: number, to: number, typeId: number): boolean
    neighbors(id: number, opts?: { maxDepth?: number; edgeTypeFilter?: number[] }): NeighborEntry[]
    neighborsBatch(ids: number[], opts?: { maxDepth?: number; edgeTypeFilter?: number[] }): NeighborEntry[][]
    vectorSearch(query: string | VectorSearchQuery): VectorSearchHit[]
    personalizedPageRank(opts: PPROptions): { nodeId: number; score: number }[]
    allShortestPaths(opts: ShortestPathOpts): { path: number[]; cost: number }[]
    connectedComponents(opts?: ConnectedComponentsOpts): number[][]
    degrees(id: number): { inDegree: number; outDegree: number }
    queryPattern(opts: PatternOpts): JsNodeRecord[]
    compact(): void
    stats(): StorageStats
    exportSnapshot(): Uint8Array
    importSnapshot(data: Uint8Array): void
  }
}
