/**
 * ID Encoder — 节点 ID 编解码工具
 */
export declare class IdEncoder {
    /**
     * 将字符串名称哈希为数字节点 ID
     *
     * 使用 SHA-256 取前 6 字节（48-bit），保证：
     * - 在 Number.MAX_SAFE_INTEGER (2^53 - 1) 内
     * - 极低的碰撞概率（2^-192）
     * - 对相同 name 返回恒定 ID
     */
    static nameToId(name: string): number;
    /**
     * 将数字节点 ID 转回字符串表示
     */
    static idToName(id: number): string;
    /**
     * 生成全局唯一 ID（基于名称 + 时间戳）
     */
    static generateUniqueId(prefix?: string): string;
}
//# sourceMappingURL=id-encoder.d.ts.map