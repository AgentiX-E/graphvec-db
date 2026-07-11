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
import * as fs from 'fs'
import * as path from 'path'

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

  /** 获取指定类型的所有Node ID */
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

  /** 暴露内部 index 的引用，用于测试 */
  getRawIndex(): Map<number, Set<NodeId>> {
    return this.index
  }

  // ──────────────────────────────────────────────
  //  持久化
  // ──────────────────────────────────────────────

  private static readonly LABEL_INDEX_FILENAME = 'label-index.json'
  private static readonly LABEL_INDEX_VERSION = 1

  /**
   * 将标签索引序列化保存到指定目录。
   * 使用原子写入：先写入 .tmp 文件，然后 renameSync 到目标文件。
   */
  save(saveDir: string): void {
    const data: { version: number; labels: Record<string, number[]> } = {
      version: LabelEngine.LABEL_INDEX_VERSION,
      labels: {},
    }
    for (const [typeId, nodeIds] of this.index.entries()) {
      data.labels[String(typeId)] = Array.from(nodeIds)
    }
    const filePath = path.join(saveDir, LabelEngine.LABEL_INDEX_FILENAME)
    const tmpPath = filePath + '.tmp'
    fs.mkdirSync(saveDir, { recursive: true })
    fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf-8')
    fs.renameSync(tmpPath, filePath)
  }

  /**
   * 从指定目录加载标签索引。
   * 如果文件不存在或格式损坏，静默失败（索引保持为空状态）。
   */
  load(saveDir: string): void {
    const filePath = path.join(saveDir, LabelEngine.LABEL_INDEX_FILENAME)
    if (!fs.existsSync(filePath)) return

    let data: { version: number; labels: Record<string, number[]> }
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      data = JSON.parse(raw)
    } catch {
      // 文件损坏 → 从空索引开始
      return
    }

    if (!data || typeof data.version !== 'number' || !data.labels) return

    this.index.clear()
    for (const [typeStr, nodeIds] of Object.entries(data.labels)) {
      const typeId = Number(typeStr)
      if (Array.isArray(nodeIds) && nodeIds.length > 0) {
        this.index.set(typeId, new Set(nodeIds))
      }
    }
  }
}
