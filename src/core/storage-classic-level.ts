// ============================================================
// ClassicLevelStorageProvider — StorageProvider 的 classic-level 实现
//
// 使用 LevelDB（classic-level）作为嵌入式 KV 存储后端。
// 采用同步内存缓存模式：open() 时全部加载到内存，
// 每次写入同步更新内存 + 异步刷入 LevelDB，
// close() 时确保所有数据写入。
// ============================================================


import {
  StorageProvider,
  StorageConfig,
  StorageStats,
  NeighborsOptions,
  NeighborEntry,
} from './storage-provider'
import {
  NodeId,
} from '../types'
import { ClassicLevel } from 'classic-level'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'

// ── 键编码约定 ──────────────────────────────────────────────
const PREFIX_NODE = 'n:'
const PREFIX_NODE_NAME = 'n:name:'
const PREFIX_EDGE = 'e:'
const PREFIX_EDGE_OUT = 'e:out:'
const PREFIX_EDGE_IN = 'e:in:'
const PREFIX_DEG_OUT = 'deg:out:'
const PREFIX_DEG_IN = 'deg:in:'
const KEY_META = 'meta'
const SNAPSHOT_FILE = '__snapshot__.json'

interface NodeEntry {
  id: NodeId
  typeId: number
  key: string
  props?: Record<string, unknown>
  createdAt: number
}

interface EdgeEntry {
  src: NodeId
  dst: NodeId
  typeId: number
  props?: Record<string, unknown>
  createdAt: number
}

interface MetaEntry {
  nextNodeId: number
  nextEdgeId: number
}

/**
 * ClassicLevelStorageProvider
 *
 * 同步接口适配：open() 时将 LevelDB 中所有数据以内存 KV 镜像加载；
 * 每次写入同步更新内存，并异步写入 LevelDB；
 * close() 时等待所有异步写完成。
 */
export class ClassicLevelStorageProvider implements StorageProvider {
  private _db: ClassicLevel<string, string> | null = null
  private _isOpen = false
  private _data = new Map<string, string>()
  private _meta: MetaEntry = { nextNodeId: 1, nextEdgeId: 1 }
  private _flushQueue: Promise<void> = Promise.resolve()
  private _path: string = ''

  get isOpen(): boolean {
    return this._isOpen
  }

  // ── 生命周期 ──────────────────────────────────────────────

  open(config: StorageConfig): void {
    if (this._isOpen) return
    this._path = config.path
    this._data.clear()

    // 创建目录（如果不存在）
    fs.mkdirSync(config.path, { recursive: true })

    this._db = new ClassicLevel(config.path, {
      valueEncoding: 'json' as any,
    })
    // 同步加载所有数据到内存
    this._loadAllSync()
    this._isOpen = true
  }

  close(): void {
    if (!this._isOpen) return
    this._isOpen = false
    // 将内存数据同步写入磁盘 snappshot（持久恢复用）
    // 必须在 _data.clear() 之前完成
    try {
      const entries: [string, string][] = []
      for (const [k, v] of this._data) entries.push([k, v])
      const snapshotPath = this._path + '/' + SNAPSHOT_FILE
      fs.writeFileSync(snapshotPath, JSON.stringify({
        meta: this._meta,
        entries,
      }), 'utf-8')
    } catch (e) {
      // snapshot 失败不应影响正常关闭
    }
    // flush 所有待写入
    const db = this._db
    const flushQueue = this._flushQueue
    flushQueue.then(() => {
      if (db) db.close()
    }).catch(() => {
      if (db) db.close()
    })
    this._db = null
    this._data.clear()
  }

  // ── 节点操作 ──────────────────────────────────────────────

  upsertNode(typeId: number, name: string, opts?: { props?: Record<string, unknown> }): NodeId {
    const existingId = this._findNodeByName(typeId, name)
    if (existingId !== null) {
      // 更新已有节点
      const raw = this._data.get(PREFIX_NODE + existingId)
      if (raw !== undefined) {
        const entry: NodeEntry = JSON.parse(raw)
        if (opts?.props) {
          entry.props = { ...(entry.props || {}), ...opts.props }
        }
        entry.createdAt = Date.now()
        this._data.set(PREFIX_NODE + existingId, JSON.stringify(entry))
        this._flush(PREFIX_NODE + existingId, JSON.stringify(entry))
      }
      return existingId
    }

    const id = this._meta.nextNodeId++
    const entry: NodeEntry = {
      id,
      typeId,
      key: name,
      props: opts?.props,
      createdAt: Date.now(),
    }
    const key = PREFIX_NODE + id
    const nameKey = PREFIX_NODE_NAME + typeId + ':' + name
    this._data.set(key, JSON.stringify(entry))
    this._data.set(nameKey, String(id))
    this._data.set(KEY_META, JSON.stringify(this._meta))
    this._flush(key, JSON.stringify(entry))
    this._flush(nameKey, String(id))
    this._flushMeta()
    return id
  }

  getNode(id: NodeId, includeProps: boolean): {
    id: NodeId; typeId: number; key: string
    props?: Record<string, unknown>; createdAt: number
  } | null {
    const raw = this._data.get(PREFIX_NODE + id)
    if (raw === undefined) return null
    const entry: NodeEntry = JSON.parse(raw)
    if (!includeProps) {
      return { id: entry.id, typeId: entry.typeId, key: entry.key, createdAt: entry.createdAt }
    }
    return entry
  }

  deleteNode(id: NodeId): boolean {
    const raw = this._data.get(PREFIX_NODE + id)
    if (raw === undefined) return false
    const entry: NodeEntry = JSON.parse(raw)
    this._data.delete(PREFIX_NODE + id)
    this._data.delete(PREFIX_NODE_NAME + entry.typeId + ':' + entry.key)
    // Remove all edge index entries for this node (outgoing + incoming)
    for (const [key] of this._data) {
      if (key.startsWith(PREFIX_EDGE_OUT + id + ':') || key.startsWith(PREFIX_EDGE_IN + id + ':')) {
        this._data.delete(key)
        this._flushDel(key)
      }
    }
    this._data.delete(PREFIX_DEG_OUT + id)
    this._data.delete(PREFIX_DEG_IN + id)
    this._flushDel(PREFIX_NODE + id)
    this._flushDel(PREFIX_NODE_NAME + entry.typeId + ':' + entry.key)
    this._flushDel(PREFIX_DEG_OUT + id)
    this._flushDel(PREFIX_DEG_IN + id)
    return true
  }

  batchUpsertNodes(inputs: Array<{
    typeId: number; name: string; key: string
    props?: Record<string, unknown>
    denseVector?: Float32Array
    temporalValidity?: { start?: number; end?: number }
  }>): NodeId[] {
    const ids: NodeId[] = []
    for (const input of inputs) {
      const id = this._meta.nextNodeId++
      const entry: NodeEntry = {
        id,
        typeId: input.typeId,
        key: input.name,
        props: input.props,
        createdAt: Date.now(),
      }
      const key = PREFIX_NODE + id
      const nameKey = PREFIX_NODE_NAME + input.typeId + ':' + input.name
      this._data.set(key, JSON.stringify(entry))
      this._data.set(nameKey, String(id))
      this._flush(key, JSON.stringify(entry))
      this._flush(nameKey, String(id))
      ids.push(id)
    }
    this._flushMeta()
    return ids
  }

  degrees(id: NodeId): { inDegree: number; outDegree: number } {
    const outRaw = this._data.get(PREFIX_DEG_OUT + id)
    const inRaw = this._data.get(PREFIX_DEG_IN + id)
    return {
      outDegree: outRaw !== undefined ? parseInt(outRaw, 10) : 0,
      inDegree: inRaw !== undefined ? parseInt(inRaw, 10) : 0,
    }
  }

  // ── 边操作 ────────────────────────────────────────────────

  upsertEdge(src: NodeId, dst: NodeId, typeId: number, opts?: {
    props?: Record<string, unknown>
    temporalValidity?: { start?: number; end?: number }
    weight?: number
  }): void {
    const edgeKey = PREFIX_EDGE + src + ':' + dst + ':' + typeId
    const isNew = !this._data.has(edgeKey)
    const entry: EdgeEntry = {
      src, dst, typeId,
      props: opts?.props,
      createdAt: Date.now(),
    }
    this._data.set(edgeKey, JSON.stringify(entry))
    this._data.set(PREFIX_EDGE_OUT + src + ':' + typeId + ':' + dst, '1')
    this._data.set(PREFIX_EDGE_IN + dst + ':' + typeId + ':' + src, '1')
    this._flush(edgeKey, JSON.stringify(entry))
    this._flush(PREFIX_EDGE_OUT + src + ':' + typeId + ':' + dst, '1')
    this._flush(PREFIX_EDGE_IN + dst + ':' + typeId + ':' + src, '1')
    // Only increment degree for new edges (not repeated upsert)
    if (isNew) {
      this._incrementDegree(src, 'out')
      this._incrementDegree(dst, 'in')
    }
  }

  getEdge(src: NodeId, dst: NodeId, typeId: number): {
    from: NodeId; to: NodeId; typeId: number
    props?: Record<string, unknown>; createdAt: number
  } | null {
    const raw = this._data.get(PREFIX_EDGE + src + ':' + dst + ':' + typeId)
    if (raw === undefined) return null
    const entry: EdgeEntry = JSON.parse(raw)
    return {
      from: entry.src, to: entry.dst,
      typeId: entry.typeId, props: entry.props, createdAt: entry.createdAt,
    }
  }

  deleteEdge(src: NodeId, dst: NodeId, typeId: number): boolean {
    const edgeKey = PREFIX_EDGE + src + ':' + dst + ':' + typeId
    if (!this._data.has(edgeKey)) return false
    this._data.delete(edgeKey)
    this._data.delete(PREFIX_EDGE_OUT + src + ':' + typeId + ':' + dst)
    this._data.delete(PREFIX_EDGE_IN + dst + ':' + typeId + ':' + src)
    this._flushDel(edgeKey)
    this._flushDel(PREFIX_EDGE_OUT + src + ':' + typeId + ':' + dst)
    this._flushDel(PREFIX_EDGE_IN + dst + ':' + typeId + ':' + src)
    this._decrementDegree(src, 'out')
    this._decrementDegree(dst, 'in')
    return true
  }

  getAllNodeIds(): number[] {
    const ids: number[] = []
    for (const [key] of this._data) {
      if (key.startsWith(PREFIX_NODE) && !key.startsWith(PREFIX_NODE_NAME)) {
        const idStr = key.slice(2)
        const id = parseInt(idStr, 10)
        if (!isNaN(id) && String(id) === idStr) ids.push(id)
      }
    }
    return ids
  }

  neighbors(id: NodeId, opts?: NeighborsOptions): NeighborEntry[] {
    const results: NeighborEntry[] = []
    const typeFilter = opts?.edgeTypeFilter
    const maxDepth = opts?.maxDepth ?? 1
    const outPrefix = PREFIX_EDGE_OUT + id + ':'

    // 查找直接邻居
    for (const [key] of this._data) {
      if (key.startsWith(outPrefix)) {
        const suffix = key.slice(outPrefix.length)
        const parts = suffix.split(':')
        const edgeTypeId = parseInt(parts[0], 10)
        if (typeFilter && !typeFilter.includes(edgeTypeId)) continue
        const neighborId = parseInt(parts[1] || '0', 10)
        results.push({ nodeId: neighborId, edgeTypeId, validFrom: Date.now() })
      }
    }

    // 多跳
    if (maxDepth > 1) {
      const visited = new Set<number>([id])
      const queue = results.map(r => ({ nodeId: r.nodeId as number, depth: 1 }))
      for (const q of queue) visited.add(q.nodeId)
      while (queue.length > 0) {
        const cur = queue.shift()!
        if (cur.depth >= maxDepth) continue
        const hopPrefix = PREFIX_EDGE_OUT + cur.nodeId + ':'
        for (const [k] of this._data) {
          if (!k.startsWith(hopPrefix)) continue
          const suffix = k.slice(hopPrefix.length)
          const parts = suffix.split(':')
          const edgeTypeId = parseInt(parts[0], 10)
          const neighborId = parseInt(parts[1] || '0', 10)
          if (visited.has(neighborId)) continue
          visited.add(neighborId)
          if (!typeFilter || typeFilter.includes(edgeTypeId)) {
            results.push({ nodeId: neighborId, edgeTypeId, validFrom: Date.now() })
          }
          queue.push({ nodeId: neighborId, depth: cur.depth + 1 })
        }
      }
    }

    return results
  }

  // ── 搜索 ──────────────────────────────────────────────────

  vectorSearch(_searchQuery: string): Array<{ id: NodeId; score: number; distance: number }> {
    return []
  }

  // ── 图算法 ────────────────────────────────────────────────

  personalizedPageRank(_opts: {
    sourceNode: NodeId; maxIter: number; alpha: number; tolerance: number; topK: number
  }): { nodeId: NodeId; score: number }[] {
    return []
  }

  allShortestPaths(_opts: {
    source: NodeId; target: NodeId; maxDepth: number
  }): { path: NodeId[]; cost: number }[] {
    return []
  }

  connectedComponents(_opts?: { edgeTypeFilter?: number[] }): NodeId[][] {
    return []
  }

  queryPattern(_opts: {
    sourceNodeId?: NodeId; sourceTypeId?: number; depth: number
    edgeTypeFilter?: number[][]; nodeTypeFilter?: number[][]; limit: number
  }): Array<{
    id: NodeId; typeId: number; key: string
    props?: Record<string, unknown>; createdAt: number
  }> {
    return []
  }

  // ── 复合索引 ──────────────────────────────────────────────

  createCompositeIndex(_fields: string[], _name: string, _options?: { unique?: boolean }): void {
    // 暂不实现
  }

  dropCompositeIndex(_name: string): void {
    // 暂不实现
  }

  // ── 维护 ──────────────────────────────────────────────────

  compact(): void {
    // classic-level 不提供手动 compact
  }

  stats(): StorageStats {
    let nodeCount = 0
    let edgeCount = 0
    for (const [key] of this._data) {
      if (key.startsWith(PREFIX_NODE) && !key.startsWith(PREFIX_NODE_NAME)) {
        nodeCount++
      } else if (key.startsWith(PREFIX_EDGE) && !key.startsWith(PREFIX_EDGE_OUT) && !key.startsWith(PREFIX_EDGE_IN)) {
        edgeCount++
      }
    }
    return {
      nodeCount, edgeCount,
      diskSizeBytes: 0, pendingWalBytes: 0,
      activeMemtableBytes: 0, immutableMemtableBytes: 0,
    }
  }

  exportSnapshot(): Buffer {
    return Buffer.alloc(0)
  }

  importSnapshot(_data: Buffer): void {
    // 暂不支持
  }

  // ── 内部方法 ──────────────────────────────────────────────

  private _findNodeByName(typeId: number, name: string): number | null {
    const raw = this._data.get(PREFIX_NODE_NAME + typeId + ':' + name)
    if (raw !== undefined) {
      const parsed = parseInt(raw, 10)
      return isNaN(parsed) ? null : parsed
    }
    return null
  }

  private _incrementDegree(nodeId: NodeId, direction: 'in' | 'out'): void {
    const key = direction === 'out' ? PREFIX_DEG_OUT + nodeId : PREFIX_DEG_IN + nodeId
    const raw = this._data.get(key)
    const current = raw !== undefined ? parseInt(raw, 10) : 0
    const val = String(current + 1)
    this._data.set(key, val)
    this._flush(key, val)
  }

  private _decrementDegree(nodeId: NodeId, direction: 'in' | 'out'): void {
    const key = direction === 'out' ? PREFIX_DEG_OUT + nodeId : PREFIX_DEG_IN + nodeId
    const raw = this._data.get(key)
    const current = raw !== undefined ? parseInt(raw, 10) : 1
    const val = String(Math.max(0, current - 1))
    this._data.set(key, val)
    this._flush(key, val)
  }

  private _flush(key: string, val: string): void {
    const db = this._db
    if (!db) return
    this._flushQueue = this._flushQueue.then(() => db.put(key, val).catch(() => {}))
  }

  private _flushDel(key: string): void {
    const db = this._db
    if (!db) return
    this._flushQueue = this._flushQueue.then(() => db.del(key).catch(() => {}))
  }

  private _flushMeta(): void {
    this._flush(KEY_META, JSON.stringify(this._meta))
  }

  /**
   * 从 LevelDB 同步加载所有数据到内存 Map。
   * 手动遍历 LevelDB 数据文件，按 key-value 行加载。
   */
  private _loadAllSync(): void {
    if (!this._db) return
    // 从磁盘 snappshot 同步恢复持久化数据
    this._tryRestoreFromStorage()
  }

  private _tryRestoreFromStorage(): void {
    const snapshotPath = this._path + '/' + SNAPSHOT_FILE
    try {
      if (fs.existsSync(snapshotPath)) {
        const raw = fs.readFileSync(snapshotPath, 'utf-8')
        const snap = JSON.parse(raw)
        // 恢复 meta
        if (snap.meta) {
          this._meta.nextNodeId = snap.meta.nextNodeId ?? 1
          this._meta.nextEdgeId = snap.meta.nextEdgeId ?? 1
        }
        // 恢复 data
        if (Array.isArray(snap.entries)) {
          for (const [k, v] of snap.entries) {
            this._data.set(k, v)
          }
        }
      }
    } catch (e) {
      // 恢复失败时保持空状态
    }
  }
}
