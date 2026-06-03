// ============================================================
// TTL Index — 自动过期索引
//
// 支持：
// - 为节点设置过期时间（TTL）
// - 后台定时扫描过期节点
// - 过期时触发回调（删除节点）
// - 支持动态调整 TTL 和移除 TTL
// ============================================================

export type NodeId = number

/**
 * TTL 扫描触发器
 */
export interface TTLTickHandler {
  (expiredNodeIds: NodeId[]): void
}

/**
 * TTLIndex — 节点自动过期索引
 *
 * 内部使用 Map<number, Set<NodeId>> 以过期时间戳为 key：
 *   key   = 过期 Unix 时间戳（毫秒）
 *   value = 在该时间戳到期的所有节点
 *
 * 扫描策略：
 * - tickAll(): 扫描所有已过期节点（当前时间 > 过期时间）
 * - 由外部调用者决定扫描时机（setInterval / cron / 事件触发）
 * - 每个 tick 返回过期节点列表
 */
export class TTLIndex {
  private _map: Map<number, Set<NodeId>>
  private _nodeTTL: Map<NodeId, number>  // nodeId → expireAt (ms)
  private _onExpire: TTLTickHandler | null = null

  /** 索引节点总数 */
  get size(): number {
    return this._nodeTTL.size
  }

  constructor(onExpire?: TTLTickHandler) {
    this._map = new Map<number, Set<NodeId>>()
    this._nodeTTL = new Map()
    if (onExpire) this._onExpire = onExpire
  }

  /**
   * 为节点设置过期时间（以当前时间为基准的秒数）
   * ttlSeconds > 0: 节点将在 ttlSeconds 秒后过期
   * ttlSeconds <= 0: 节点立即过期
   */
  setTTL(nodeId: NodeId, ttlSeconds: number): void {
    const expireAt = ttlSeconds > 0
      ? Date.now() + ttlSeconds * 1000
      : 0  // 立即过期

    this._removeFromIndex(nodeId)

    if (!Number.isFinite(expireAt)) return

    this._nodeTTL.set(nodeId, expireAt)

    let bucket = this._map.get(expireAt)
    if (!bucket) {
      bucket = new Set<NodeId>()
      this._map.set(expireAt, bucket)
    }
    bucket.add(nodeId)
  }

  /**
   * 为节点设置绝对过期时间戳（毫秒）
   */
  setExpireAt(nodeId: NodeId, expireAtMs: number): void {
    this._removeFromIndex(nodeId)

    if (!Number.isFinite(expireAtMs)) return

    this._nodeTTL.set(nodeId, expireAtMs)

    let bucket = this._map.get(expireAtMs)
    if (!bucket) {
      bucket = new Set<NodeId>()
      this._map.set(expireAtMs, bucket)
    }
    bucket.add(nodeId)
  }

  /**
   * 移除节点的 TTL
   */
  removeTTL(nodeId: NodeId): void {
    this._removeFromIndex(nodeId)
  }

  /**
   * 检查节点是否有 TTL
   */
  hasTTL(nodeId: NodeId): boolean {
    return this._nodeTTL.has(nodeId)
  }

  /**
   * 获取节点的过期时间戳（毫秒），无 TTL 返回 -1
   */
  getExpireAt(nodeId: NodeId): number {
    return this._nodeTTL.get(nodeId) ?? -1
  }

  /**
   * 扫描所有已过期节点
   * 返回已过期但尚未清理的节点 ID 列表
   * 如果设置了 onExpire 回调，自动调用
   *
   * 扫描 O(n) 其中 n = 唯一过期时间戳数（通常远小于节点数）
   */
  tickAll(): NodeId[] {
    const now = Date.now()
    const expiredNodeIds: NodeId[] = []
    const keysToDelete: number[] = []

    for (const [expireAt, nodeSet] of this._map) {
      if (expireAt > now) continue

      keysToDelete.push(expireAt)
      for (const id of nodeSet) {
        if (this._nodeTTL.get(id) !== expireAt) continue  // 已被移除或更新
        expiredNodeIds.push(id)
        this._nodeTTL.delete(id)
      }
    }

    for (const key of keysToDelete) {
      this._map.delete(key)
    }

    if (expiredNodeIds.length > 0 && this._onExpire) {
      this._onExpire(expiredNodeIds)
    }

    return expiredNodeIds
  }

  /**
   * 清空所有 TTL 记录
   */
  clear(): void {
    this._map.clear()
    this._nodeTTL.clear()
  }

  // ── 内部 ─────────────────────────────────

  private _removeFromIndex(nodeId: NodeId): void {
    const oldExpire = this._nodeTTL.get(nodeId)
    if (oldExpire !== undefined) {
      const oldBucket = this._map.get(oldExpire)
      if (oldBucket) {
        oldBucket.delete(nodeId)
        if (oldBucket.size === 0) {
          this._map.delete(oldExpire)
        }
      }
    }
    this._nodeTTL.delete(nodeId)
  }
}
