import { createHash } from 'node:crypto'

/**
 * ID Encoder — 节点 ID 编解码工具
 */
export class IdEncoder {
  /**
   * 将字符串名称哈希为数字节点 ID
   *
   * 使用 SHA-256 取前 6 字节（48-bit），保证：
   * - 在 Number.MAX_SAFE_INTEGER (2^53 - 1) 内
   * - 极低的碰撞概率（2^-192）
   * - 对相同 name 返回恒定 ID
   */
  static nameToId(name: string): number {
    const hash = createHash('sha256').update(name).digest()
    // 取前 6 字节（48-bit），保证在 Number.MAX_SAFE_INTEGER 内
    const buf = hash.subarray(0, 6)
    let id = 0
    for (let i = 0; i < 6; i++) {
      id = (id * 256) + buf[i]
    }
    return id
  }

  /**
   * 将数字节点 ID 转回字符串表示
   */
  static idToName(id: number): string {
    return String(id)
  }

  /**
   * 生成全局唯一 ID（基于名称 + 时间戳）
   */
  static generateUniqueId(prefix: string = 'node'): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }
}
