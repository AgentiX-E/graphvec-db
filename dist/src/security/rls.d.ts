/**
 * rls.ts — 行级安全（Row-Level Security）
 *
 * 在 graph 查询/写入时根据用户上下文过滤数据。
 * 每条策略包含目标表和过滤函数，enforceQuery 在查询结果上应用过滤。
 */
import { Role } from '../types';
export interface RLSContext {
    userId: string;
    role: Role;
    /** 用户所属租户/组织，用于多租户隔离 */
    tenantId?: string;
    /** 附加属性，可用于更细粒度的过滤 */
    properties?: Record<string, unknown>;
}
export interface RLSPolicy {
    /** 目标表: 'nodes' | 'edges' | 'graph' | '*' */
    table: string;
    /** 策略名称（用于调试） */
    name: string;
    /** 过滤函数：返回 true 表示该记录对用户可见 */
    filter: (ctx: RLSContext, record: unknown) => boolean;
}
/**
 * RowLevelSecurity — 行级安全引擎
 *
 * 使用方式：
 * ```ts
 * const rls = new RowLevelSecurity()
 * // 多租户隔离策略
 * rls.addPolicy({
 *   table: 'nodes',
 *   name: 'tenant-isolation',
 *   filter: (ctx, record: any) => !ctx.tenantId || record.tenantId === ctx.tenantId,
 * })
 * ```
 */
export declare class RowLevelSecurity {
    private policies;
    /** 添加一条 RLS 策略 */
    addPolicy(p: RLSPolicy): void;
    /** 移除一条策略 */
    removePolicy(name: string): boolean;
    /** 获取所有策略 */
    getPolicies(): ReadonlyArray<RLSPolicy>;
    /** 清除所有策略 */
    clear(): void;
    /**
     * 对查询结果执行 RLS 过滤
     * @param table 查询的表名
     * @param ctx 用户上下文
     * @param records 原始查询结果
     * @returns 过滤后的结果
     */
    enforceQuery<T>(table: string, ctx: RLSContext, records: T[]): T[];
    /**
     * 检查用户是否对某条记录有权限
     */
    checkRecord(table: string, ctx: RLSContext, record: unknown): boolean;
}
//# sourceMappingURL=rls.d.ts.map