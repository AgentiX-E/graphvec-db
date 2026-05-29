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
//  49       N      Payload data     (分片数据 or 空)
//
// 流结束：发送一个 flags=0 (非数据) 的最终校验块，totalChunks=0xFFFFFFFF，
//        其 SHA-256 为全量数据的哈希。

/** 块头大小（Magic 4 + Flags 1 + ChkIdx 4 + TotalChunks 4 + DataLen 4 + SHA256 32 = 49 字节） */
const CHUNK_HEADER_SIZE = 49
const MAGIC = Buffer.from([0x47, 0x53, 0x4E, 0x50]) // "GSNP"
const FLAG_DATA = 0x01
const FLAG_FINAL_CHECKSUM = 0x00
const FINAL_TOTAL_CHUNKS = 0xFFFFFFFF

/** 组装一个数据块的 Buffer */
export function buildDataChunk(chunkIndex: number, totalChunks: number, data: Buffer): Buffer {
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
export function buildFinalChecksumChunk(fullSha256: Buffer): Buffer {
  const header = Buffer.alloc(CHUNK_HEADER_SIZE)
  MAGIC.copy(header, 0)
  header[4] = FLAG_FINAL_CHECKSUM
  header.writeUInt32LE(0, 5)          // chunkIndex = 0 (reserved)
  header.writeUInt32LE(FINAL_TOTAL_CHUNKS, 9) // 哨兵值
  header.writeUInt32LE(0, 13)         // dataLength = 0
  fullSha256.copy(header, 17)
  return header
}

/** 解析后的块 */
export interface ParsedChunk {
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
export function parseChunk(buf: Buffer): ParsedChunk {
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

/**
 * 将一个 Buffer 分片为块序列（包含最终校验块）。
 * 这是纯函数，不依赖 any 存储实例。
 *
 * @param data   要分片的数据
 * @param chunkSize  每块 payload 最大字节数（默认 4MB）
 */
export function* chunkBuffer(data: Buffer, chunkSize: number = 4 * 1024 * 1024): Generator<Buffer> {
  const fullSha = crypto.createHash('sha256').update(data).digest()
  const totalChunks = Math.ceil(data.length / chunkSize)
  let offset = 0
  for (let i = 0; i < totalChunks; i++) {
    const end = Math.min(offset + chunkSize, data.length)
    const chunkData = Buffer.from(data.subarray(offset, end))
    yield buildDataChunk(i, totalChunks, chunkData)
    offset = end
  }
  yield buildFinalChecksumChunk(fullSha)
}

/**
 * 从流式块序列重组数据并校验。
 * 返回原始数据 Buffer。
 * @throws 任意块校验失败或最终校验不匹配
 */
export async function reassembleFromStream(stream: AsyncIterable<Buffer>): Promise<Buffer> {
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

  const fullData = Buffer.concat(chunks)

  // 全量数据校验
  const actualFullSha = crypto.createHash('sha256').update(fullData).digest()
  if (!actualFullSha.equals(finalSha256)) {
    throw new Error(
      `Snapshot full-data checksum mismatch: ` +
      `expected ${finalSha256.toString('hex')}, got ${actualFullSha.toString('hex')}`
    )
  }

  return fullData
}

/**
 * 原子方式写入流式快照到文件。
 *
 * 步骤：
 * 1. 创建 `.tmp` 临时文件
 * 2. 逐块写入
 * 3. 全部写入完成后重命名为 `.snap`
 * 4. 任意步骤失败 → 删除 .tmp 文件
 *
 * @param snapPath  目标 .snap 文件路径
 * @param stream    块迭代器
 */
export async function writeSnapshotStreamToFile(
  snapPath: string,
  stream: AsyncIterable<Buffer>,
): Promise<void> {
  const dir = path.dirname(snapPath)
  const base = path.basename(snapPath, '.snap')
  const tmpPath = path.join(dir, `${base}.tmp`)

  try {
    const ws = fs.createWriteStream(tmpPath)
    for await (const chunk of stream) {
      ws.write(chunk)
    }
    await new Promise<void>((resolve, reject) => {
      ws.end((err) => (err ? reject(err) : resolve()))
    })
    await fsp.rename(tmpPath, snapPath)
  } catch (err) {
    try { await fsp.unlink(tmpPath) } catch { /* ignore */ }
    throw err
  }
}

/**
 * 从 `.snap` 文件读取所有块，返回数据迭代器。
 */
export async function* readChunksFromFile(filePath: string): AsyncGenerator<Buffer> {
  const bytes = await fsp.readFile(filePath)
  let offset = 0
  while (offset < bytes.length) {
    if (offset + CHUNK_HEADER_SIZE > bytes.length) break
    const hdr = Buffer.from(bytes.subarray(offset, offset + CHUNK_HEADER_SIZE))
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
    yield Buffer.from(bytes.subarray(offset, offset + chunkLen))
    offset += chunkLen
  }
}


// ═══════════════════════════════════════════════
// OverGraphStorage
// ═══════════════════════════════════════════════

/**
 * 属性 MsgPack 编码的存储键。
 * 当压缩启用时，props 被编码为一个 __msgpack key 下的 number[]。
 */
const PROPS_COMPRESSED_KEY = '__c'

/**
 * 序列化属性对象。
 * 当 compressionStrategy === 'msgpack' 时使用 msgpackr encode，
 * 结果以 number[] 形式存储（可被 serde_json 处理）。
 * 否则原样返回。
 */
function _serializeProps(props: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (props === undefined || props === null) return undefined
  // Encode to msgpack Buffer, then convert to number[] for JSON-safe storage
  const buf = encode(props) as Buffer
  return { [PROPS_COMPRESSED_KEY]: Array.from(buf) }
}

/**
 * 反序列化属性对象。
 * 检测是否以 __msgpack key 下的 number[] 形式存储，
 * 如果是则解码返回原始对象。
 * 否则直接返回（原始 JSON 对象）。
 */
function _deserializeProps(data: unknown): Record<string, unknown> | undefined {
  if (data === undefined || data === null) return undefined
  if (typeof data === 'object' && !Array.isArray(data) && data !== null) {
    const obj = data as Record<string, unknown>
    const raw = obj[PROPS_COMPRESSED_KEY]
    if (raw !== undefined && Array.isArray(raw)) {
      // Decode from number[] → Buffer → msgpack
      return decode(Buffer.from(raw)) as Record<string, unknown>
    }
    // Plain object — already deserialized by OverGraph's JSON deserialization
    return obj
  }
  // Unexpected format
  return data as Record<string, unknown>
}

export class OverGraphStorage implements StorageProvider {
  private _db: OverGraphDB | null = null
  private _isOpen = false
  private _compress = false
  private _compressionStrategy: 'none' | 'msgpack' = 'none'

  get isOpen(): boolean { return this._isOpen }
  get compressionEnabled(): boolean { return this._compress }

  open(config: StorageConfig): void {
    if (this._isOpen) return

    // 存储压缩配置
    this._compress = config.compress === true
    this._compressionStrategy = config.compressionStrategy ?? (this._compress ? 'msgpack' : 'none')

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
    const props = this._compress && this._compressionStrategy === 'msgpack'
      ? _serializeProps(opts?.props as Record<string, unknown> | undefined)
      : opts?.props as Record<string, unknown> | undefined
    return this._db!.upsertNode(typeId, name, {
      props,
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
      props: _deserializeProps(raw.props),
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
    const mapped = inputs.map(i => ({
      ...i,
      props: this._compress && this._compressionStrategy === 'msgpack'
        ? _serializeProps(i.props)
        : i.props,
    }))
    return this._db!.batchUpsertNodes(mapped)
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
    const props = this._compress && this._compressionStrategy === 'msgpack'
      ? _serializeProps(opts?.props)
      : opts?.props
    this._db!.upsertEdge(src, dst, typeId, {
      props,
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
      props: _deserializeProps(raw.props),
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
      props: _deserializeProps(n.props),
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

  /**
   * 导出快照 — 使用 msgpackr 序列化
   *
   * 格式: { rangeId, nodes: [...], edges: [...] }
   * - nodes: 每个 node 记录 { typeId, name, props }
   * - edges: 每个 edge 记录 { src, dst, typeId, props }
   */
  exportSnapshot(): Buffer {
    // 通过 OverGraph API 遍历所有数据
    const nodes: Array<{ id: number; typeId: number; name: string; props?: Record<string, unknown> }> = []
    const edges: Array<{ src: number; dst: number; typeId: number; props?: Record<string, unknown> }> = []

    // 使用 exportAdjacency 获取节点和边信息
    const adj = this._db!.exportAdjacency()
    const nodeIds = Array.from(adj.nodeIds as Float64Array)

    for (const id of nodeIds) {
      const node = this._db!.getNode(id, true)
      if (node) {
        nodes.push({
          id: node.id,
          typeId: node.typeId,
          name: node.key,
          props: _deserializeProps(node.props),
        })
      }
    }

    // 边信息
    const fromIds = adj.edgeFrom as Float64Array
    const toIds = adj.edgeTo as Float64Array
    const typeIds = adj.edgeTypeIds as Uint32Array

    for (let i = 0; i < fromIds.length; i++) {
      const edge = this._db!.getEdge(fromIds[i], toIds[i], typeIds[i])
      edges.push({
        src: fromIds[i],
        dst: toIds[i],
        typeId: typeIds[i],
        props: edge?.props ? _deserializeProps(edge.props) : undefined,
      })
    }

    const data = {
      rangeId: '',
      nodes,
      edges,
    }
    return Buffer.from(encode(data))
  }

  /**
   * 导入快照
   *
   * 解析 msgpackr 格式，逐条写入数据库。
   */
  importSnapshot(data: Buffer): void {
    const snapshot = decode(Buffer.from(data)) as {
      rangeId?: string
      nodes?: Array<{ id: number; typeId: number; name: string; props?: Record<string, unknown> }>
      edges?: Array<{ src: number; dst: number; typeId: number; props?: Record<string, unknown> }>
    }

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

  /**
   * 分块导出快照 — 返回 AsyncGenerator，按 chunkSize 分块发出 Buffer。
   *
   * 调用 exportSnapshot() 获取完整快照数据，然后按 chunkSize 分片。
   * 最后发出 SHA-256 最终校验块。
   */
  async *exportSnapshotChunked(chunkSize: number = 4 * 1024 * 1024): AsyncGenerator<Buffer> {
    const data = this.exportSnapshot()
    for (const chunk of chunkBuffer(data, chunkSize)) {
      yield chunk
    }
  }

  /**
   * 原子方式写入分块快照到文件。
   *
   * 步骤：
   * 1. 创建临时文件 `snapshot-{id}.tmp`
   * 2. 逐块写入
   * 3. 全部写入完成后重命名为 `*.snap`
   * 4. 任意步骤失败 → 删除 .tmp 文件
   */
  async exportSnapshotAtomic(
    filePath: string,
    chunkSize: number = 4 * 1024 * 1024,
  ): Promise<void> {
    await writeSnapshotStreamToFile(filePath, this.exportSnapshotChunked(chunkSize))
  }

  /**
   * 从流式数据导入分块快照。
   * 校验每个块及最终 SHA-256，然后调用 importSnapshot() 恢复。
   */
  async importSnapshotStream(stream: AsyncIterable<Buffer>): Promise<void> {
    const fullData = await reassembleFromStream(stream)
    this.importSnapshot(fullData)
  }

  /**
   * 从 `.snap` 文件导入快照。
   */
  async importSnapshotFile(filePath: string): Promise<void> {
    await this.importSnapshotStream(readChunksFromFile(filePath))
  }
}
