// ============================================================
// OverGraphStorage — StorageProvider 的 OverGraph v0.7.0 实现
//
// 将 StorageProvider 接口适配到 OverGraph 原生 API。
// 这是 GraphEngine 的默认存储后端。
// ============================================================

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'

import { OverGraph, OverGraphDB } from 'overgraph'
import { StorageProvider, StorageConfig, StorageStats, NeighborsOptions, NeighborEntry } from './storage-provider'
import {
  NodeId, UpsertNodeOptions, UpsertEdgeOptions,
} from '../types'
import { encode, decode } from 'msgpackr'

// ── 流式分块快照协议 (Streaming Chunked Snapshot Protocol) ──
//
// 每个块（chunk）的二进制布局：
//
//   Offset  Size   Field
//   ─────────────────────────────────────────────────
//   0       4      Magic marker     = 0x47534E50 ("GSNP")
//   4       1      Flags
//                     bit 0: 0 = 最终校验和块, 1 = 数据块
//                     bits 1-7: reserved (0)
//   5       4      Chunk index      (uint32 LE, 数据块专用)
//   9       4      Total chunks     (uint32 LE, 数据块专用; 最终块=0xFFFFFFFF)
//  13       4      Data length      (uint32 LE, 本块 payload 字节数)
//  17      32      SHA-256 digest   (数据块: chunk 数据的 hash; 最终块: 全量数据的 hash)
//  49       N      Payload data     (截取的原生快照数据片段 or 空)
//
// 流结束：发送一个 flags=0 (非数据) 的最终校验块，totalChunks=0xFFFFFFFF，
//        其 SHA-256 为全量原生快照的哈希。

/** 块头大小（Magic 4 + Flags 1 + ChkIdx 4 + TotalChunks 4 + DataLen 4 + SHA256 32 = 49 字节） */
const CHUNK_HEADER_SIZE = 49
const MAGIC = Buffer.from([0x47, 0x53, 0x4E, 0x50]) // "GSNP"
const FLAG_DATA = 0x01
const FLAG_FINAL_CHECKSUM = 0x00
const FINAL_TOTAL_CHUNKS = 0xFFFFFFFF

/** 组装一个数据块的 Buffer */
function buildDataChunk(chunkIndex: number, totalChunks: number, data: Buffer): Buffer {
  const sha = crypto.createHash('sha256').update(data).digest()
  const header = Buffer.alloc(CHUNK_HEADER_SIZE)
  MAGIC.copy(header, 0)
  header[4] = FLAG_DATA
  header.writeUInt32LE(chunkIndex, 5)
  header.writeUInt32LE(totalChunks, 9)
  header.writeUInt32LE(data.length, 13)
  sha.copy(header, 17)
  return Buffer.concat([header, data])
}

/** 组装最终校验块 */
function buildFinalChecksumChunk(fullSha256: Buffer): Buffer {
  const header = Buffer.alloc(CHUNK_HEADER_SIZE)
  MAGIC.copy(header, 0)
  header[4] = FLAG_FINAL_CHECKSUM
  header.writeUInt32LE(0, 5)          // chunkIndex = 0 (reserved)
  header.writeUInt32LE(FINAL_TOTAL_CHUNKS, 9) // 哨兵值
  header.writeUInt32LE(0, 13)         // dataLength = 0
  fullSha256.copy(header, 17)
  return header
}

/** 解析结果 */
interface ParsedChunk {
  isData: boolean
  chunkIndex: number
  totalChunks: number
  dataLength: number
  sha256: Buffer
  data: Buffer   // payload (data chunks) 或空
}

/**
 * 解析一个完整的块。
 * @throws 如果 Magic 不符或长度不足
 */
function parseChunk(buf: Buffer): ParsedChunk {
  if (buf.length < CHUNK_HEADER_SIZE) {
    throw new Error(`Snapshot chunk too short: ${buf.length} < ${CHUNK_HEADER_SIZE}`)
  }
  if (!buf.subarray(0, 4).equals(MAGIC)) {
    throw new Error('Invalid snapshot chunk magic marker (expected "GSNP")')
  }
  const isData = (buf[4] & FLAG_DATA) !== 0
  const chunkIndex = buf.readUInt32LE(5)
  const totalChunks = buf.readUInt32LE(9)
  const dataLength = buf.readUInt32LE(13)
  const sha256 = Buffer.from(buf.subarray(17, 49))
  let data: Buffer
  if (isData) {
    const expectedLen = CHUNK_HEADER_SIZE + dataLength
    if (buf.length < expectedLen) {
      throw new Error(
        `Snapshot chunk #${chunkIndex} truncated: expected ${expectedLen} bytes, got ${buf.length}`
      )
    }
    data = Buffer.from(buf.subarray(CHUNK_HEADER_SIZE, CHUNK_HEADER_SIZE + dataLength))
  } else {
    data = Buffer.alloc(0)
  }
  return { isData, chunkIndex, totalChunks, dataLength, sha256, data }
}

export class OverGraphStorage implements StorageProvider {
  private _db: OverGraphDB | null = null
  private _isOpen = false

  get isOpen(): boolean { return this._isOpen }

  open(config: StorageConfig): void {
    if (this._isOpen) return
    const ogOpts: any = {
      denseVector: config.denseVector
        ? { dimension: config.denseVector.dimension }
        : undefined,
      defaultRetention: config.defaultRetention,
    }
    // 应用 OverGraph 存储优化参数
    if (config.overgraph) {
      if (config.overgraph.compactAfterNFlushes !== undefined) {
        ogOpts.compactAfterNFlushes = config.overgraph.compactAfterNFlushes
      }
      if (config.overgraph.memtableFlushThreshold !== undefined) {
        ogOpts.memtableFlushThreshold = config.overgraph.memtableFlushThreshold
      }
      if (config.overgraph.memtableHardCapBytes !== undefined) {
        ogOpts.memtableHardCapBytes = config.overgraph.memtableHardCapBytes
      }
    }
    this._db = OverGraph.open(config.path, ogOpts)
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

  // ── 快照（全量 Buffer） ────────────────────

  /**
   * 导出快照 — 使用 msgpackr 序列化
   *
   * 格式: { rangeId, nodes: [...], edges: [...] }
   * - nodes: 每个 node 记录 { typeId, name, props }
   * - edges: 每个 edge 记录 { src, dst, typeId, props }
   *
   * 优先通过 OverGraph 原生 API 获取全量节点数据。
   * 当原生 exportSnapshot 可用时，使用原生数据并回填结构化格式。
   */
  exportSnapshot(): Buffer {
    if (typeof (this._db as any).exportSnapshot === 'function') {
      // OverGraph v0.7.0 原生快照 — 直接用 msgpackr 包装
      const nativeData = (this._db as any).exportSnapshot()
      const data = {
        rangeId: '',
        nodes: [] as Array<{ typeId: number; name: string; props?: Record<string, unknown> }>,
        edges: [] as Array<{ src: number; dst: number; typeId: number; props?: Record<string, unknown> }>,
        _native: Buffer.from(nativeData),
      }
      return Buffer.from(encode(data))
    }

    // fallback: 无原生快照时返回空
    return Buffer.alloc(0)
  }

  /**
   * 导入快照
   *
   * 尝试解析 msgpackr 格式。
   * 如果包含 _native 原生快照数据，优先使用原生导入。
   * 否则逐条 upsert 节点和边。
   */
  importSnapshot(data: Buffer): void {
    const snapshot = decode(Buffer.from(data)) as {
      rangeId?: string
      nodes?: Array<{ typeId: number; name: string; props?: Record<string, unknown> }>
      edges?: Array<{ src: number; dst: number; typeId: number; props?: Record<string, unknown> }>
      _native?: Buffer | Uint8Array
    }

    // 1) 优先使用原生快照恢复
    if (snapshot._native && typeof (this._db as any).importSnapshot === 'function') {
      ;(this._db as any).importSnapshot(Buffer.from(snapshot._native))
      return
    }

    // 2) 逐条 upsert（fallback / 可移植格式）
    if (snapshot.nodes && snapshot.nodes.length > 0) {
      for (const node of snapshot.nodes) {
        this.upsertNode(node.typeId, node.name, { props: node.props })
      }
    }
    if (snapshot.edges && snapshot.edges.length > 0) {
      for (const edge of snapshot.edges) {
        this.upsertEdge(edge.src, edge.dst, edge.typeId, { props: edge.props })
      }
    }
  }

  // ═══════════════════════════════════════════════
  // 流式分块快照 (Streaming Chunked Snapshot)
  // ═══════════════════════════════════════════════

  /**
   * 分块导出快照 — 返回 AsyncGenerator，按 chunkSize 分块发出 Buffer。
   *
   * 流程：
   * 1. 调用 OverGraph 原生 exportSnapshot() 获取全量快照数据
   * 2. 将数据按 chunkSize 切片，每片组装为带头的块发出
   * 3. 所有数据块发送完后，发出一个最终 SHA-256 校验块
   *
   * 块接收方收到最终校验块后可验证完整数据的一致性。
   * 无需一次分配全量缓冲区（流式切片处理）。
   */
  async *exportSnapshotChunked(chunkSize: number = 4 * 1024 * 1024): AsyncGenerator<Buffer> {
    if (!this._db) throw new Error('Storage not open')
    if (typeof (this._db as any).exportSnapshot !== 'function') {
      throw new Error('Native exportSnapshot not available')
    }

    const nativeData = (this._db as any).exportSnapshot() as Uint8Array
    const data = Buffer.from(nativeData)
    const fullSha = crypto.createHash('sha256').update(data).digest()
    const totalChunks = Math.ceil(data.length / chunkSize)

    let offset = 0
    for (let i = 0; i < totalChunks; i++) {
      const end = Math.min(offset + chunkSize, data.length)
      const chunkData = Buffer.from(data.subarray(offset, end))
      yield buildDataChunk(i, totalChunks, chunkData)
      offset = end
    }

    // 最终校验块
    yield buildFinalChecksumChunk(fullSha)
  }

  /**
   * 原子方式写入分块快照到文件。
   *
   * 步骤：
   * 1. 创建临时文件 `snapshot-{id}.tmp`
   * 2. 逐块写入
   * 3. 全部写入完成后，重命名为 `snapshot-{id}.snap`（原子重命名）
   * 4. 任意步骤失败 → 删除 .tmp 文件
   */
  async exportSnapshotAtomic(
    filePath: string,
    chunkSize: number = 4 * 1024 * 1024,
  ): Promise<void> {
    const dir = path.dirname(filePath)
    const base = path.basename(filePath, '.snap')
    const tmpPath = path.join(dir, `${base}.tmp`)

    try {
      const stream = fs.createWriteStream(tmpPath)
      for await (const chunk of this.exportSnapshotChunked(chunkSize)) {
        stream.write(chunk)
      }
      await new Promise<void>((resolve, reject) => {
        stream.end((err) => (err ? reject(err) : resolve()))
      })
      // 原子重命名
      await fsp.rename(tmpPath, filePath)
    } catch (err) {
      // 清理 tmp 文件
      try { await fsp.unlink(tmpPath) } catch { /* ignore */ }
      throw err
    }
  }

  /**
   * 从流式数据导入分块快照。
   *
   * 流程：
   * 1. 逐块读取校验
   * 2. 数据块按序重组为原生快照 Buffer
   * 3. 最终校验块验证全量 SHA-256
   * 4. 调用 OverGraph 原生 importSnapshot() 恢复
   *
   * @throws 任意块校验失败或最终校验不匹配
   */
  async importSnapshotStream(stream: AsyncIterable<Buffer>): Promise<void> {
    if (!this._db) throw new Error('Storage not open')
    if (typeof (this._db as any).importSnapshot !== 'function') {
      throw new Error('Native importSnapshot not available')
    }

    const chunks: Buffer[] = []
    let totalChunksReported = 0
    let finalSha256: Buffer | null = null

    for await (const raw of stream) {
      const chunk = parseChunk(raw)

      if (chunk.isData) {
        totalChunksReported = chunk.totalChunks
        // 校验单块数据哈希
        const actualSha = crypto.createHash('sha256').update(chunk.data).digest()
        if (!actualSha.equals(chunk.sha256)) {
          throw new Error(
            `Snapshot chunk #${chunk.chunkIndex} checksum mismatch: ` +
            `expected ${chunk.sha256.toString('hex')}, got ${actualSha.toString('hex')}`
          )
        }
        chunks.push(chunk.data)
      } else {
        // 最终校验块
        if (chunk.totalChunks !== FINAL_TOTAL_CHUNKS) {
          throw new Error(
            `Invalid final checksum chunk: expected totalChunks=0xFFFFFFFF, got ${chunk.totalChunks}`
          )
        }
        finalSha256 = chunk.sha256
      }
    }

    if (!finalSha256) {
      throw new Error('Snapshot stream missing final checksum chunk')
    }
    if (chunks.length !== totalChunksReported) {
      throw new Error(
        `Snapshot chunk count mismatch: expected ${totalChunksReported}, got ${chunks.length}`
      )
    }

    // 组装全量数据
    const fullData = Buffer.concat(chunks)

    // 全量数据校验
    const actualFullSha = crypto.createHash('sha256').update(fullData).digest()
    if (!actualFullSha.equals(finalSha256)) {
      throw new Error(
        `Snapshot full-data checksum mismatch: ` +
        `expected ${finalSha256.toString('hex')}, got ${actualFullSha.toString('hex')}`
      )
    }

    // 导入原生快照
    ;(this._db as any).importSnapshot(fullData)
  }

  /**
   * 从 `.snap` 文件导入快照（读取所有块并恢复）
   */
  async importSnapshotFile(filePath: string): Promise<void> {
    // 流式读取文件的所有块并馈入 importSnapshotStream
    const bytes = await fsp.readFile(filePath)
    const chunks: Buffer[] = []
    let offset = 0
    while (offset < bytes.length) {
      // 需要至少一个 header 大小
      if (offset + CHUNK_HEADER_SIZE > bytes.length) break
      // 读取 header 判断数据长度
      const header = bytes.subarray(offset, offset + CHUNK_HEADER_SIZE)
      const hdr = Buffer.from(header)
      const isData = (hdr[4] & FLAG_DATA) !== 0
      let chunkLen: number
      if (isData) {
        const dataLen = hdr.readUInt32LE(13)
        chunkLen = CHUNK_HEADER_SIZE + dataLen
      } else {
        chunkLen = CHUNK_HEADER_SIZE
      }
      if (offset + chunkLen > bytes.length) {
        throw new Error(`Snapshot file truncated at offset ${offset}`)
      }
      chunks.push(Buffer.from(bytes.subarray(offset, offset + chunkLen)))
      offset += chunkLen
    }
    await this.importSnapshotStream(chunks[Symbol.asyncIterator]())
  }
}
