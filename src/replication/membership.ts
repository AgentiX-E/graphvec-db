import * as crypto from 'node:crypto'

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

export interface ClusterNode {
  id: string
  address: string
  virtualNodes?: number
  createdAt: number
  active: boolean
}

export type NodeChangeEvent = 'add' | 'remove'
export type NodeChangeCallback = (event: NodeChangeEvent, node: ClusterNode) => void

// ──────────────────────────────────────────
// ConsistentHashRing — 一致性哈希环
// ──────────────────────────────────────────

/**
 * 一致性哈希环，支持虚拟节点、副本查找和动态成员变更。
 *
 * 工作原理：
 * - 每个物理节点在环上分布 virtualNodes 个虚拟节点
 * - 查找 key 时，将 key 哈希后顺时针查找第一个虚拟节点
 * - 节点加入/离开时自动 rehash，仅影响相邻区域的数据分布
 */
export class ConsistentHashRing {
  /** hash → nodeId 映射（环上所有虚拟节点） */
  private ring: Map<number, string> = new Map()
  /** 排序后的哈希值列表（二分查找用） */
  private sortedKeys: number[] = []
  /** 物理节点注册表 */
  private nodes: Map<string, ClusterNode> = new Map()
  /** 默认每个物理节点的虚拟节点数量 */
  private virtualNodes: number = 100
  /** 成员变更回调 */
  private _changeCallbacks: NodeChangeCallback[] = []

  constructor(config?: { virtualNodes?: number }) {
    if (config?.virtualNodes !== undefined) {
      this.virtualNodes = config.virtualNodes
    }
  }

  // ── 成员变更 ──

  /**
   * 向环中添加一个物理节点。
   * 自动创建 virtualNodes 个虚拟节点并分布到环上。
   *
   * @param node - 要添加的节点
   */
  addNode(node: ClusterNode): void {
    if (this.nodes.has(node.id)) {
      return // 重复添加，静默忽略
    }

    const vnodes = node.virtualNodes ?? this.virtualNodes
    const record: ClusterNode = {
      ...node,
      virtualNodes: vnodes,
    }
    this.nodes.set(node.id, record)

    // 创建虚拟节点
    for (let i = 0; i < vnodes; i++) {
      this._addVirtualNode(node.id, i)
    }

    // 触发回调
    for (const cb of this._changeCallbacks) {
      cb('add', record)
    }
  }

  /**
   * 从环中移除一个物理节点。
   * 自动移除该节点下的所有虚拟节点。
   *
   * @param nodeId - 要移除的节点 ID
   */
  removeNode(nodeId: string): void {
    const node = this.nodes.get(nodeId)
    if (!node) {
      return // 节点不存在，静默忽略
    }

    const vnodes = node.virtualNodes ?? this.virtualNodes

    // 移除所有虚拟节点
    for (let i = 0; i < vnodes; i++) {
      this._removeVirtualNode(nodeId, i)
    }

    this.nodes.delete(nodeId)

    // 触发回调
    for (const cb of this._changeCallbacks) {
      cb('remove', node)
    }
  }

  // ── 路由 ──

  /**
   * 根据 key 查找对应的物理节点 ID。
   * 通过一致性哈希找到顺时针方向第一个虚拟节点的归属物理节点。
   *
   * @param key - 路由键
   * @returns 物理节点 ID
   * @throws {Error} 环为空时抛出
   */
  getNode(key: string): string {
    if (this.sortedKeys.length === 0) {
      throw new Error('HashRing is empty — no nodes available')
    }

    const hash = this._hash(key)
    const nodeId = this._findNearestNode(hash)
    return nodeId
  }

  /**
   * 获取指定 key 的副本（replica）节点列表。
   * 通过哈希环顺时针查找，跳过重复的物理节点。
   *
   * @param key - 路由键
   * @param count - 需要的副本数
   * @returns 物理节点 ID 列表（可能少于 count，如果环上节点不足）
   */
  getReplicas(key: string, count: number): string[] {
    if (this.sortedKeys.length === 0 || count <= 0) {
      return []
    }

    const hash = this._hash(key)
    const replicas: string[] = []
    const seen = new Set<string>()

    // 从 hash 位置开始，顺时针遍历 sortedKeys
    let idx = this._binarySearch(hash)
    if (idx >= this.sortedKeys.length) {
      idx = 0 // 绕回起点
    }

    // 最多遍历所有虚拟节点
    for (let i = 0; i < this.sortedKeys.length && replicas.length < count; i++) {
      const ringHash = this.sortedKeys[(idx + i) % this.sortedKeys.length]
      const nodeId = this.ring.get(ringHash)!
      if (!seen.has(nodeId)) {
        seen.add(nodeId)
        replicas.push(nodeId)
      }
    }

    return replicas
  }

  // ── 查询 ──

  /** 获取所有物理节点 */
  getNodes(): ClusterNode[] {
    return Array.from(this.nodes.values())
  }

  /** 获取物理节点数量 */
  getNodeCount(): number {
    return this.nodes.size
  }

  /** 获取虚拟节点总数量 */
  getVirtualNodeCount(): number {
    return this.ring.size
  }

  /** 获取物理节点（通过 ID） */
  getNodeById(nodeId: string): ClusterNode | undefined {
    return this.nodes.get(nodeId)
  }

  // ── 事件 ──

  /**
   * 注册成员变更回调。
   * 在节点加入/离开时触发。
   */
  onNodeChange(callback: NodeChangeCallback): void {
    this._changeCallbacks.push(callback)
  }

  /**
   * 移除成员变更回调。
   */
  offNodeChange(callback: NodeChangeCallback): void {
    const idx = this._changeCallbacks.indexOf(callback)
    if (idx !== -1) {
      this._changeCallbacks.splice(idx, 1)
    }
  }

  // ── 内部方法 ──

  /**
   * MD5 哈希函数。
   * 取前 8 个十六进制字符转为数字（32-bit），提供良好的分布性。
   */
  private _hash(key: string): number {
    const hash = crypto.createHash('md5').update(key).digest('hex')
    return parseInt(hash.substring(0, 8), 16)
  }

  /** 在环上添加一个虚拟节点 */
  private _addVirtualNode(physicalNodeId: string, virtualIdx: number): void {
    const vkey = `${physicalNodeId}:vnode:${virtualIdx}`
    const hash = this._hash(vkey)

    // 处理哈希冲突：如果已有节点，前移一个位置
    let finalHash = hash
    while (this.ring.has(finalHash)) {
      finalHash = (finalHash + 1) >>> 0 // 无符号右移确保在 0-2^32-1 范围
    }

    this.ring.set(finalHash, physicalNodeId)
    this._sortKeys()
  }

  /** 从环上移除一个虚拟节点 */
  private _removeVirtualNode(physicalNodeId: string, virtualIdx: number): void {
    const vkey = `${physicalNodeId}:vnode:${virtualIdx}`
    const hash = this._hash(vkey)

    this.ring.delete(hash)
    this._sortKeys()
  }

  /** 对环上的哈希值排序（二分查找前置操作） */
  private _sortKeys(): void {
    this.sortedKeys = Array.from(this.ring.keys()).sort((a, b) => a - b)
  }

  /**
   * 在排序后的哈希列表中，找到顺时针方向第一个 >= hash 的虚拟节点。
   * 如果所有哈希值都小于 hash，则回到列表第一个（绕环）。
   */
  private _findNearestNode(hash: number): string {
    const idx = this._binarySearch(hash)
    const targetIdx = idx < this.sortedKeys.length ? idx : 0
    const ringHash = this.sortedKeys[targetIdx]
    return this.ring.get(ringHash)!
  }

  /** 二分查找第一个 >= hash 的索引 */
  private _binarySearch(hash: number): number {
    let low = 0
    let high = this.sortedKeys.length - 1

    while (low <= high) {
      const mid = (low + high) >>> 1
      const midVal = this.sortedKeys[mid]

      if (midVal < hash) {
        low = mid + 1
      } else {
        high = mid - 1
      }
    }

    return low
  }
}

// ──────────────────────────────────────────
// ClusterManager — 集群管理者
// ──────────────────────────────────────────

/**
 * 集群管理者，封装一致性哈希环的成员变更操作。
 *
 * 职责：
 * 1. 管理集群节点的加入/离开
 * 2. 基于一致性哈希的 shard 路由
 * 3. 提供集群状态快照
 *
 * 这不是真正的 Raft 成员变更，而是通过一致性哈希实现
 * 的"伪成员变更"——当节点加入/离开时自动 rehash 重新分布数据。
 */
export class ClusterManager {
  private hashRing: ConsistentHashRing

  constructor(config?: { virtualNodes?: number }) {
    this.hashRing = new ConsistentHashRing(config)
  }

  /**
   * 节点加入集群。
   * 自动在一致性哈希环上创建虚拟节点。
   */
  join(node: ClusterNode): void {
    this.hashRing.addNode(node)
  }

  /**
   * 节点离开集群。
   * 自动从一致性哈希环上移除所有虚拟节点。
   */
  leave(nodeId: string): void {
    this.hashRing.removeNode(nodeId)
  }

  /**
   * 根据 shardKey 路由 shard 到对应的物理节点。
   *
   * @param shardKey - 分片 key（如节点名称、边 key）
   * @returns 目标物理节点 ID
   * @throws {Error} 集群为空时抛出
   */
  routeShard(shardKey: string): string {
    return this.hashRing.getNode(shardKey)
  }

  /**
   * 获取 shard 的副本节点列表。
   *
   * @param shardKey - 分片 key
   * @param count - 副本数量
   * @returns 副本节点 ID 列表
   */
  getShardReplicas(shardKey: string, count: number = 3): string[] {
    return this.hashRing.getReplicas(shardKey, count)
  }

  /**
   * 获取所有集群节点。
   */
  getNodes(): ClusterNode[] {
    return this.hashRing.getNodes()
  }

  /**
   * 获取集群节点数量。
   */
  getNodeCount(): number {
    return this.hashRing.getNodeCount()
  }

  /**
   * 注册成员变更回调。
   */
  onNodeChange(callback: NodeChangeCallback): void {
    this.hashRing.onNodeChange(callback)
  }

  /**
   * 获取哈希环的文本状态报告。
   * 包含节点数量、虚拟节点数量、各节点的虚拟节点分布。
   */
  getRingStatus(): string {
    const nodes = this.hashRing.getNodes()
    const totalVnodes = this.hashRing.getVirtualNodeCount()

    let status = `Cluster: ${nodes.length} nodes, ${totalVnodes} virtual nodes\n`
    for (const node of nodes) {
      status += `  Node ${node.id} (${node.address}) — active: ${node.active}, virtual: ${node.virtualNodes ?? 100}\n`
    }
    return status.trim()
  }
}
