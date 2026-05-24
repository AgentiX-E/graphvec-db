// ============================================================
// LabelEngine — 标签索引引擎
//
// 维护 type → nodeId Set 映射，支持：
// - addNode/removeNode 操作
// - getNodeIds(type) 查询
// - stats() 返回计数统计
// - clear() / reset() 清理
// ============================================================

import { NodeId } from '../types'

export interface LabelStats {
  types: number
  totalNodes: number
  typeCounts: Record<number, number>
}

export class LabelEngine {
  private index: Map<number, Set<NodeId>> = new Map()

  /** 添加节点到指定类型 */
  addNode(type: number, nodeId: NodeId): void {
    if (!this.index.has(type)) {
      this.index.set(type, new Set())
    }
    this.index.get(type)!.add(nodeId)
  }

  /** 从指定类型移除节点 */
  removeNode(type: number, nodeId: NodeId): boolean {
    const set = this.index.get(type)
    if (!set) return false
    const removed = set.delete(nodeId)
    if (set.size === 0) {
      this.index.delete(type)
    }
    return removed
  }

  /** 获取指定类型的所有节点 ID */
  getNodeIds(type: number): NodeId[] {
    const set = this.index.get(type)
    return set ? Array.from(set) : []
  }

  /** 获取统计数据 */
  stats(): LabelStats {
    const typeCounts: Record<number, number> = {}
    let totalNodes = 0
    for (const [type, set] of this.index.entries()) {
      const count = set.size
      typeCounts[type] = count
      totalNodes += count
    }
    return {
      types: this.index.size,
      totalNodes,
      typeCounts,
    }
  }

  /** 清理所有数据 */
  clear(): void {
    this.index.clear()
  }

  /** 重置到初始状态（同 clear） */
  reset(): void {
    this.clear()
  }
}
