/**
 * membership-route-table.ts — 成员路由表
 *
 * 为 AppMembershipManager 提供 peerId↔addr 映射。
 * commit 后自动更新路由表，确保 transport.sendTo() 适配器发现新节点。
 *
 * 结构：
 * - RouteTable: Map<peerId, { addr: string; healthy: boolean; addedAt: number }>
 * - RouteUpdate: commit 后广播给所有节点
 * - 与 HeartbeatManager 共享 peer 列表
 */

import { Logger } from '../ops/logger'

export interface RouteEntry {
  addr: string
  healthy: boolean
  addedAt: number
}

export class MembershipRouteTable {
  private _routes = new Map<string, RouteEntry>()
  private logger: Logger

  constructor() {
    this.logger = new Logger('MembershipRouteTable')
  }

  /** 初始化路由表 */
  initialize(peers: Array<{ nodeId: string; addr: string }>): void {
    const now = Date.now()
    for (const p of peers) {
      this._routes.set(p.nodeId, {
        addr: p.addr,
        healthy: true,
        addedAt: now,
      })
    }
  }

  /** 获取 peer 地址 */
  getAddr(peerId: string): string | undefined {
    return this._routes.get(peerId)?.addr
  }

  /** 添加或更新路由 */
  setRoute(peerId: string, addr: string): void {
    const existing = this._routes.get(peerId)
    if (existing) {
      existing.addr = addr
      existing.healthy = true
    } else {
      this._routes.set(peerId, {
        addr,
        healthy: true,
        addedAt: Date.now(),
      })
    }
  }

  /** 标记 peer 健康状态 */
  setHealth(peerId: string, healthy: boolean): void {
    const entry = this._routes.get(peerId)
    if (entry) {
      entry.healthy = healthy
    }
  }

  /** 移除 peer 路由 */
  removeRoute(peerId: string): void {
    this._routes.delete(peerId)
  }

  /** 获取所有在线 peer 数量 */
  getOnlineCount(): number {
    let count = 0
    for (const entry of this._routes.values()) {
      if (entry.healthy) count++
    }
    return count
  }

  /** 转换为 peer 列表 */
  toPeers(): Array<{ nodeId: string; addr: string }> {
    const peers: Array<{ nodeId: string; addr: string }> = []
    for (const [nodeId, entry] of this._routes) {
      peers.push({ nodeId, addr: entry.addr })
    }
    return peers
  }

  /** 当前路由表快照 */
  snapshot(): Map<string, RouteEntry> {
    return new Map(this._routes)
  }
}
