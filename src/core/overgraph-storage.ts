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

import { OverGraph } from 'overgraph'
import { StorageProvider, StorageConfig, StorageStats, NeighborsOptions, NeighborEntry } from './storage-provider'
import {
  NodeId, UpsertNodeOptions, UpsertEdgeOptions,
} from '../types'
import { encode, decode } from 'msgpackr'
import { GeoIndex } from './geo-index'
import { EncryptionAtRest, CipherConfig } from './cipher'
import { ColumnarIndex } from './columnar-index'

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
// Edge write cache (workaround for Rust read-your-write inconsistency)
//
// OverGraph Rust 原生 getEdgeByTriple 在 upsertEdge 后存在缓存未刷新问题：
// - upsertEdge → getEdgeByTriple 返回旧 props
// - getEdgeByTriple 可能忽略 typeId 参数，返回错误 label 的 edge
// - node 操作无此问题
//
// 方案：在 JS 层维护一个写入缓存，upsertEdge 后写缓存，getEdge 先查缓存
// ═══════════════════════════════════════════════

/** 缓存的最大条目数 */
const EDGE_CACHE_MAX = 1000

/** 缓存的 edge 条目 */
interface CachedEdge {
  from: number
  to: number
  typeId: number
  props?: Record<string, unknown>
  createdAt: number
}

/**
 * 简单的 LRU Map：最近读取的条目保持在末尾，
 * 超过容量时淘汰 Map 迭代的第一个条目（最久未访问）。
 */
class LRUMap<K, V> {
  private _map = new Map<K, V>()
  private _capacity: number

  constructor(capacity: number) {
    this._capacity = capacity
  }

  get size(): number { return this._map.size }

  get(key: K): V | undefined {
    const val = this._map.get(key)
    if (val !== undefined) {
      // 移到末尾（最近使用）
      this._map.delete(key)
      this._map.set(key, val)
    }
    return val
  }

  set(key: K, value: V): void {
    if (this._map.has(key)) {
      this._map.delete(key)
    } else if (this._map.size >= this._capacity) {
      // 淘汰最久未访问的（Map 迭代的第一个）
      const firstKey = this._map.keys().next().value
      if (firstKey !== undefined) {
        this._map.delete(firstKey)
      }
    }
    this._map.set(key, value)
  }

  delete(key: K): boolean {
    return this._map.delete(key)
  }

  has(key: K): boolean {
    return this._map.has(key)
  }

  clear(): void {
    this._map.clear()
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

/**
 * 复合索引条目定义
 */
export interface CompositeIndexDef {
  fields: string[]
  unique: boolean
  /** 索引数据: compositeKey → nodeId[] */
  data: Map<string, number[]>
}

export class OverGraphStorage implements StorageProvider {
  private _db: OverGraph | null = null
  private _isOpen = false
  private _compress = false
  private _compressionStrategy: 'none' | 'msgpack' = 'none'

  /** Encryption at rest (optional) */
  private _cipher: EncryptionAtRest | null = null

  /** 地理空间索引 */
  private _geoIndex: GeoIndex = new GeoIndex()
  /** 地理坐标属性字段名（纬度、经度），可通过 config 覆盖 */
  private _geoLatField: string = '_lat'
  private _geoLngField: string = '_lng'

  /** 复合索引集合: name → index definition */
  private _compositeIndexes: Map<string, CompositeIndexDef> = new Map()

  /** 列式索引 */
  private _colIndex: ColumnarIndex | null = null

  /** 边写入缓存 — workaround for Rust read-your-write inconsistency */
  private _edgeCache: LRUMap<string, CachedEdge> = new LRUMap(EDGE_CACHE_MAX)

  /** 缓存统计 */
  private _edgeCacheHits = 0
  private _edgeCacheMisses = 0

  get isOpen(): boolean { return this._isOpen }
  get compressionEnabled(): boolean { return this._compress }
  /** Get the EncryptionAtRest instance (null if not configured) */
  get cipher(): EncryptionAtRest | null { return this._cipher }
  /** Get the ColumnarIndex instance (null if not configured) */
  get colIndex(): ColumnarIndex | null { return this._colIndex }

  /** 缓存命中率统计 */
  get edgeCacheStats(): { hits: number; misses: number; size: number; maxSize: number } {
    return {
      hits: this._edgeCacheHits,
      misses: this._edgeCacheMisses,
      size: this._edgeCache.size,
      maxSize: EDGE_CACHE_MAX,
    }
  }

  constructor(cipher?: EncryptionAtRest) {
    this._cipher = cipher ?? null
  }

  open(config: StorageConfig): void {
    if (this._isOpen) return

    // 存储压缩配置
    this._compress = config.compress === true
    this._compressionStrategy = config.compressionStrategy ?? (this._compress ? 'msgpack' : 'none')

    // 地理索引配置
    if (config.geoSpatial) {
      this._geoLatField = config.geoLatField ?? '_lat'
      this._geoLngField = config.geoLatField ?? '_lng'
    }

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

    // 初始化列式索引
    if (config.colIndex?.enable) {
      const colIdxConfig = {
        enable: true,
        columns: config.colIndex.columns,
        indexPath: config.colIndex.indexPath,
        syncOnWrite: config.colIndex.syncOnWrite ?? true,
      }
      this._colIndex = new ColumnarIndex(colIdxConfig, config.path)
      this._colIndex.open()
    }
  }

  close(): void {
    if (!this._isOpen || !this._db) return
    if (this._colIndex) {
      this._colIndex.close()
      this._colIndex = null
    }
    this._db.close()
    this._db = null
    this._isOpen = false
    // 清理缓存
    this._edgeCache.clear()
    this._edgeCacheHits = 0
    this._edgeCacheMisses = 0
  }

  // ── 节点操作 ──────────────────────────────

  upsertNode(typeId: number, name: string, opts?: UpsertNodeOptions): NodeId {
    const rawProps = opts?.props as Record<string, unknown> | undefined
    const props = this._compress && this._compressionStrategy === 'msgpack'
      ? _serializeProps(rawProps)
      : rawProps
    const id = this._db!.upsertNode(String(typeId), name, {
      props,
      denseVector: opts?.denseVector instanceof Float32Array
        ? opts.denseVector
        : opts?.denseVector ? new Float32Array(opts.denseVector) : undefined,
    })
    // 更新复合索引
    if (this._compositeIndexes.size > 0 && rawProps) {
      this._updateCompositeIndex(typeId, id, rawProps)
    }
    // 更新列索引
    if (this._colIndex && rawProps) {
      this._colIndex.updateNodeIndexes(id, rawProps)
    }
    // 更新地理索引
    if (rawProps) {
      const lat = rawProps[this._geoLatField]
      const lng = rawProps[this._geoLngField]
      if (typeof lat === 'number' && typeof lng === 'number') {
        this._geoIndex.addNode(id, lat, lng)
      }
    }
    return id
  }

  getNode(id: NodeId, includeProps: boolean): {
    id: NodeId; typeId: number; key: string
    props?: Record<string, unknown>; createdAt: number
  } | null {
    const raw = this._db!.getNode(id)
    if (!raw) return null
    return {
      id: raw.id,
      typeId: Number(raw.labels[0]) || 0,
      key: raw.key,
      props: _deserializeProps(raw.props),
      createdAt: raw.createdAt,
    }
  }

  deleteNode(id: NodeId): boolean {
    this._geoIndex.removeNode(id)
    // 清理列索引
    if (this._colIndex) {
      this._colIndex.deleteNodeIndexes(id)
    }
    // 清理复合索引
    for (const [, def] of this._compositeIndexes) {
      const key = `${def.name}:${id}`
      this._compositeIndexStore?.delete(key)
    }
    this._db!.deleteNode(id)
    return true
  }

  // ── 批量写入配置 ──────────────────────────────────

  /**
   * 批量分块大小。分批提交以防止大 transaction OOM。
   * - 节点：默认每批 2000
   * - 边：默认每批 5000
   * 可通过环境变量 OVERGRAPH_BATCH_NODE_CHUNK 和 OVERGRAPH_BATCH_EDGE_CHUNK 覆盖
   */
  private _chunkSizeNodes = parseInt(process.env.OVERGRAPH_BATCH_NODE_CHUNK ?? '2000', 10)
  private _chunkSizeEdges = parseInt(process.env.OVERGRAPH_BATCH_EDGE_CHUNK ?? '5000', 10)

  // ── 节点操作 ──────────────────────────────

  batchUpsertNodes(inputs: Array<{
    typeId: number; name: string; key: string
    props?: Record<string, unknown>
    denseVector?: Float32Array
    temporalValidity?: { start?: number; end?: number }
  }>): NodeId[] {
    const results: NodeId[] = []
    const chunkSize = Math.max(1, this._chunkSizeNodes)
    const _db = this._db!

    const processChunk = (chunk: typeof inputs) => {
      const mapped = chunk.map(i => ({
        labels: [String(i.typeId)],
        key: i.name,
        props: this._compress && this._compressionStrategy === 'msgpack'
          ? _serializeProps(i.props)
          : i.props,
      }))
      const batchResult = _db.batchUpsertNodes(mapped)
      results.push(...Array.from(batchResult))
    }

    // 分块处理
    for (let i = 0; i < inputs.length; i += chunkSize) {
      processChunk(inputs.slice(i, i + chunkSize))
    }

    return results
  }

  degrees(id: NodeId): { inDegree: number; outDegree: number } {
    const total = this._db!.degree(id)
    return { inDegree: total, outDegree: total }
  }

  // ── 边操作 ────────────────────────────────

  upsertEdge(src: NodeId, dst: NodeId, typeId: number, opts?: {
    props?: Record<string, unknown>
    temporalValidity?: { start?: number; end?: number }
    weight?: number
  }): number {
    const props = this._compress && this._compressionStrategy === 'msgpack'
      ? _serializeProps(opts?.props)
      : opts?.props
    const rawProps = opts?.props
    const id = this._db!.upsertEdge(src, dst, String(typeId), {
      props,
      weight: opts?.weight,
    })
    // 写入缓存（用 deserialized props 存储，保持 getEdge 返回格式一致）
    this._edgeCache.set(`${src}:${dst}:${typeId}`, {
      from: src,
      to: dst,
      typeId,
      props: rawProps,
      createdAt: Date.now(),
    })
    return id
  }

  batchUpsertEdges(inputs: Array<{
    src: NodeId; dst: NodeId; typeId: number
    props?: Record<string, unknown>
    weight?: number
  }>): Float64Array {
    const results: number[] = []
    const chunkSize = Math.max(1, this._chunkSizeEdges)
    const _db = this._db!

    const processChunk = (chunk: typeof inputs) => {
      const mapped = chunk.map(i => ({
        from: i.src,
        to: i.dst,
        label: String(i.typeId),
        props: this._compress && this._compressionStrategy === 'msgpack'
          ? _serializeProps(i.props)
          : i.props,
        weight: i.weight,
      }))
      const batchResult = _db.batchUpsertEdges(mapped)
      results.push(...Array.from(batchResult))
    }

    for (let i = 0; i < inputs.length; i += chunkSize) {
      processChunk(inputs.slice(i, i + chunkSize))
    }

    // 批量写入后更新缓存
    for (const input of inputs) {
      const key = `${input.src}:${input.dst}:${input.typeId}`
      this._edgeCache.set(key, {
        from: input.src,
        to: input.dst,
        typeId: input.typeId,
        props: input.props,
        createdAt: Date.now(),
      })
    }

    return new Float64Array(results)
  }

  getEdge(src: NodeId, dst: NodeId, typeId: number): {
    from: NodeId; to: NodeId; typeId: number
    props?: Record<string, unknown>; createdAt: number
  } | null {
    // 先查写入缓存（workaround for Rust read-your-write inconsistency）
    const cacheKey = `${src}:${dst}:${typeId}`
    const cached = this._edgeCache.get(cacheKey)
    if (cached) {
      this._edgeCacheHits++
      return {
        from: cached.from,
        to: cached.to,
        typeId: cached.typeId,
        props: cached.props,
        createdAt: cached.createdAt,
      }
    }
    this._edgeCacheMisses++

    const raw = this._db!.getEdgeByTriple(src, dst, String(typeId))
    if (!raw) return null
    return {
      from: raw.from,
      to: raw.to,
      typeId: Number(raw.label) || 0,
      props: _deserializeProps(raw.props),
      createdAt: raw.createdAt,
    }
  }

  deleteEdge(src: NodeId, dst: NodeId, typeId: number): boolean {
    // 从缓存中删除
    this._edgeCache.delete(`${src}:${dst}:${typeId}`)

    const raw = this._db!.getEdgeByTriple(src, dst, String(typeId))
    if (!raw) return false
    this._db!.deleteEdge(raw.id)
    return true
  }

  neighbors(id: NodeId, opts?: NeighborsOptions): NeighborEntry[] {
    const ogOpts: Record<string, unknown> = {}
    if (opts?.maxDepth !== undefined) ogOpts.maxDepth = opts.maxDepth
    if (opts?.edgeTypeFilter && opts.edgeTypeFilter.length > 0) {
      ogOpts.edgeLabelFilter = opts.edgeTypeFilter.map(t => String(t))
    }
    if (opts?.direction !== undefined) ogOpts.direction = opts.direction
    // 0.11.0 的 neighborEntry 有 label(string) 而非 edgeTypeId(number)
    const raw = this._db!.neighbors(id, ogOpts)
    return raw.map(n => ({
      nodeId: n.nodeId,
      edgeTypeId: Number(n.label) || 0,
      validFrom: n.validFrom ?? Date.now(),
    }))
  }

  // ── 搜索 ──────────────────────────────────

  vectorSearch(searchQuery: string): Array<{ id: NodeId; score: number; distance: number }> {
    return this._db!.vectorSearch(searchQuery)
  }

  // ── 图算法 ────────────────────────────────

  personalizedPageRank(opts: {
    sourceNode: NodeId; maxIter: number; alpha: number; tolerance: number; topK: number
  }): { nodeId: NodeId; score: number }[] {
    const result = this._db!.personalizedPagerank([opts.sourceNode], {
      dampingFactor: opts.alpha,
      maxIterations: opts.maxIter,
      epsilon: opts.tolerance,
      maxResults: opts.topK,
    })
    const nodeIds = Array.from(result.nodeIds)
    const scores = Array.from(result.scores)
    return nodeIds.map((id, i) => ({ nodeId: id, score: scores[i] }))
  }

  allShortestPaths(opts: {
    source: NodeId; target: NodeId; maxDepth: number
  }): { path: NodeId[]; cost: number }[] {
    return this._db!.allShortestPaths(opts.source, opts.target, {
      maxDepth: opts.maxDepth,
    }).map(sp => ({
      path: Array.from(sp.nodes),
      cost: sp.totalCost,
    }))
  }

  connectedComponents(opts?: { edgeTypeFilter?: number[] }): NodeId[][] {
    const ogOpts: Record<string, unknown> = {}
    if (opts?.edgeTypeFilter && opts.edgeTypeFilter.length > 0) {
      ogOpts.edgeLabelFilter = opts.edgeTypeFilter.map(t => String(t))
    }
    const components = this._db!.connectedComponents(ogOpts)
    // 0.11.0 返回 ComponentEntry[]（各节点 → 组件映射），需要合并
    const compMap = new Map<number, NodeId[]>()
    for (const entry of components) {
      const cid = entry.componentId
      if (!compMap.has(cid)) compMap.set(cid, [])
      compMap.get(cid)!.push(entry.nodeId)
    }
    return Array.from(compMap.values())
  }

  queryPattern(opts: {
    sourceNodeId?: NodeId; sourceTypeId?: number; depth: number
    edgeTypeFilter?: number[][]; nodeTypeFilter?: number[][]; limit: number
  }): Array<{ id: NodeId; typeId: number; key: string; props?: Record<string, unknown>; createdAt: number }> {
    // 0.11.0 无 queryPattern，使用 queryNodes 替代 + traverse
    // 如果给了 sourceNodeId，用 traverse 遍历；否则 fallback 到全量扫描
    if (opts.sourceNodeId) {
      const trav = this._db!.traverse(opts.sourceNodeId, opts.depth, {
        direction: 'out',
        edgeLabelFilter: opts.edgeTypeFilter?.flat().map(t => String(t)),
        maxDepth: opts.depth,
        limit: opts.limit,
      })
      return trav.items.map(hit => {
        const node = this._db!.getNode(hit.nodeId)
        if (!node) return null
        return {
          id: node.id,
          typeId: Number(node.labels[0]) || 0,
          key: node.key,
          props: _deserializeProps(node.props),
          createdAt: node.createdAt,
        }
      }).filter(Boolean) as Array<{ id: NodeId; typeId: number; key: string; props?: Record<string, unknown>; createdAt: number }>
    }
    // fallback: 使用 getNodeByKey 或全量查询
    return []
  }

  // ── 维护 ──────────────────────────────────

  compact(): void {
    this._db!.compact()
  }

  stats(): StorageStats {
    const s = this._db!.stats()
    return {
      nodeCount: s.segmentCount,
      edgeCount: 0,
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
    const nodes: Array<{ id: number; typeId: number; name: string; props?: Record<string, unknown> }> = []
    const edges: Array<{ src: number; dst: number; typeId: number; props?: Record<string, unknown> }> = []

    const adj = this._db!.exportAdjacency()
    const nodeIds = Array.from(adj.nodeIds)

    for (const id of nodeIds) {
      const node = this._db!.getNode(id)
      if (node) {
        nodes.push({
          id: node.id,
          typeId: Number(node.labels[0]) || 0,
          name: node.key,
          props: _deserializeProps(node.props),
        })
      }
    }

    // 0.11.0: adj.edgeLabels (string[]) + adj.edgeFrom + adj.edgeTo + adj.edgeLabelIndexes (Uint32Array)
    const fromIds = Array.from(adj.edgeFrom)
    const toIds = Array.from(adj.edgeTo)
    const edgeLabelIndexes = Array.from(adj.edgeLabelIndexes)
    const edgeLabels = adj.edgeLabels

    for (let i = 0; i < fromIds.length; i++) {
      const label = edgeLabels[edgeLabelIndexes[i]]
      const edge = this._db!.getEdgeByTriple(fromIds[i], toIds[i], label)
      edges.push({
        src: fromIds[i],
        dst: toIds[i],
        typeId: Number(label) || 0,
        props: edge?.props ? _deserializeProps(edge.props) : undefined,
      })
    }

    const data = {
      rangeId: '',
      nodes,
      edges,
    }
    const raw = Buffer.from(encode(data))

    // Encrypt the snapshot if cipher is configured
    if (this._cipher) {
      const encrypted = this._cipher.encrypt(raw)
      return EncryptionAtRest.prependFlag(encrypted)
    }

    return raw
  }

  /**
   * 导入快照
   *
   * 解析 msgpackr 格式，逐条写入数据库。
   */
  importSnapshot(data: Buffer): void {
    // Handle encrypted snapshots (flag byte prefix 0x01 = encrypted)
    let raw: Buffer
    if (data.length > 0 && (data[0] & 0x01) !== 0) {
      if (!this._cipher) {
        throw new Error(
          'Snapshot is encrypted but encryption is not configured. ' +
          'Provide an EncryptionAtRest instance to decrypt.'
        )
      }
      const encrypted = EncryptionAtRest.stripFlag(data)
      raw = this._cipher.decrypt(encrypted)
    } else {
      raw = data
    }

    const snapshot = decode(Buffer.from(raw)) as {
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

  // ── 复合索引实现 ────────────────────────

  /**
   * 创建复合索引。
   * 如果索引名称已存在则跳过。
   * 创建后会立即从所有已有的节点重建索引数据。
   */
  createCompositeIndex(fields: string[], name: string, options?: { unique?: boolean }): void {
    if (this._compositeIndexes.has(name)) {
      return // 已存在，跳过
    }
    const unique = options?.unique ?? false
    const indexData = new Map<string, number[]>()
    const def: CompositeIndexDef = { fields, unique, data: indexData }
    this._compositeIndexes.set(name, def)

    // 重建索引：扫描所有已有节点
    if (!this._db) return
    const allNodeIds = this._collectAllNodeIds()
    for (const id of allNodeIds) {
      const node = this._db!.getNode(id, true)
      if (node && node.props) {
        const values: Record<string, unknown> = {}
        let hasAllFields = true
        for (const f of fields) {
          if (node.props[f] !== undefined) {
            values[f] = node.props[f]
          } else {
            hasAllFields = false
            break
          }
        }
        if (hasAllFields) {
          this._addToCompositeIndex(name, values, id)
        }
      }
    }
  }

  /**
   * 删除复合索引。
   */
  dropCompositeIndex(name: string): void {
    this._compositeIndexes.delete(name)
  }

  /**
   * 根据索引字段的值生成复合键。
   */
  private _getCompositeIndexKey(values: Record<string, unknown>): string {
    return Object.keys(values)
      .sort()
      .map(k => String(values[k] ?? ''))
      .join('|')
  }

  /**
   * 向复合索引中添加一个条目。
   */
  private _addToCompositeIndex(indexName: string, values: Record<string, unknown>, nodeId: number): void {
    const def = this._compositeIndexes.get(indexName)
    if (!def) return

    const key = def.fields.map(f => String(values[f] ?? '')).join('|')

    if (def.unique) {
      if (def.data.has(key)) {
        const existing = def.data.get(key)!
        // 允许同一个节点 ID 重复添加到同一个键（幂等）
        if (existing.length > 0 && existing[0] !== nodeId) {
          throw new Error(
            `Unique constraint violation on composite index "${indexName}": ` +
            `key "${key}" already exists for node ${existing[0]}`
          )
        }
      }
    }

    if (!def.data.has(key)) {
      def.data.set(key, [])
    }
    const ids = def.data.get(key)!
    if (!ids.includes(nodeId)) {
      ids.push(nodeId)
    }
  }

  /**
   * 从复合索引中移除一个节点。
   */
  private _removeFromCompositeIndex(indexName: string, nodeId: number): void {
    const def = this._compositeIndexes.get(indexName)
    if (!def) return

    for (const [key, ids] of def.data.entries()) {
      const idx = ids.indexOf(nodeId)
      if (idx !== -1) {
        ids.splice(idx, 1)
        if (ids.length === 0) {
          def.data.delete(key)
        }
        break
      }
    }
  }

  /**
   * 更新所有复合索引（在 upsertNode 时调用）。
   */
  _updateCompositeIndex(typeId: number, nodeId: number, props: Record<string, unknown>): void {
    for (const [name, def] of this._compositeIndexes.entries()) {
      const values: Record<string, unknown> = {}
      let allFieldsPresent = true
      for (const f of def.fields) {
        if (props[f] !== undefined) {
          values[f] = props[f]
        } else {
          allFieldsPresent = false
          break
        }
      }

      if (allFieldsPresent) {
        // 先移除旧的键
        this._removeFromCompositeIndex(name, nodeId)
        // 添加新键
        this._addToCompositeIndex(name, values, nodeId)
      }
    }
  }

  /**
   * 通过复合索引查找节点 ID。
   * 支持精确匹配（fields 长度与索引一致）和前缀匹配（fields 是索引前缀）。
   * 如果找不到匹配的索引，返回 null（需要调用方回退到全表扫描）。
   */
  _findByCompositeIndex(fields: string[], values: Record<string, unknown>): number[] | null {
    for (const [, def] of this._compositeIndexes.entries()) {
      if (this._isIndexPrefixMatch(def.fields, fields)) {
        // 前缀匹配：需要遍历所有以 query 键为前缀的条目
        const prefix = fields.map(f => String(values[f] ?? '')).join('|')
        const results: number[] = []
        for (const [key, ids] of def.data.entries()) {
          if (key === prefix || key.startsWith(prefix + '|')) {
            for (const id of ids) {
              if (!results.includes(id)) {
                results.push(id)
              }
            }
          }
        }
        return results
      }
    }
    return null
  }

  /**
   * 判断 queryFields 是否是 indexFields 的前缀。
   */
  private _isIndexPrefixMatch(indexFields: string[], queryFields: string[]): boolean {
    if (queryFields.length > indexFields.length) return false
    for (let i = 0; i < queryFields.length; i++) {
      if (indexFields[i] !== queryFields[i]) return false
    }
    return true
  }

  /**
   * 收集所有节点 ID。
   */
  private _collectAllNodeIds(): number[] {
    if (!this._db) return []
    const ids: number[] = []
    try {
      const adj = this._db!.exportAdjacency()
      const nodeIds = Array.from(adj.nodeIds)
      for (let i = 0; i < nodeIds.length; i++) {
        ids.push(nodeIds[i])
      }
    } catch {
      // fallback: 尝试扫描已知节点范围
      for (let i = 1; i < 1000000; i++) {
        try {
          const node = this._db!.getNode(i)
          if (node) ids.push(i)
        } catch {
          break
        }
      }
    }
    return ids
  }

  // ── 地理空间查询 ──────────────────────────

  /** 获取 GeoIndex 引用（供 GraphEngine 使用） */
  get geoIndex(): GeoIndex {
    return this._geoIndex
  }

  /** 查询半径内的所有节点 ID */
  geoNearby(lat: number, lng: number, radiusKm: number): number[] {
    return this._geoIndex.queryRadius(lat, lng, radiusKm)
  }

  /** 查询指定包围盒内的所有节点 ID */
  geoBBox(
    southWest: [number, number],
    northEast: [number, number],
  ): number[] {
    return this._geoIndex.queryBBox(southWest, northEast)
  }

  /** KNN 地理查询 */
  geoKnn(
    lat: number, lng: number,
    k: number,
    maxRadiusKm?: number,
  ): number[] {
    return this._geoIndex.kNearest(lat, lng, k, maxRadiusKm)
  }
}
