"use strict";
/**
 * rls.ts — 行级安全（Row-Level Security）
 *
 * 在 graph 查询/写入时根据用户上下文过滤数据。
 * 每条策略包含目标表和过滤函数，enforceQuery 在查询结果上应用过滤。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RowLevelSecurity = void 0;
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
class RowLevelSecurity {
    policies = [];
    /** 添加一条 RLS 策略 */
    addPolicy(p) {
        this.policies.push(p);
    }
    /** 移除一条策略 */
    removePolicy(name) {
        const idx = this.policies.findIndex(p => p.name === name);
        if (idx === -1)
            return false;
        this.policies.splice(idx, 1);
        return true;
    }
    /** 获取所有策略 */
    getPolicies() {
        return this.policies;
    }
    /** 清除所有策略 */
    clear() {
        this.policies = [];
    }
    /**
     * 对查询结果执行 RLS 过滤
     * @param table 查询的表名
     * @param ctx 用户上下文
     * @param records 原始查询结果
     * @returns 过滤后的结果
     */
    enforceQuery(table, ctx, records) {
        const matched = this.policies.filter(p => p.table === table || p.table === '*' || p.table === 'graph');
        if (matched.length === 0)
            return records;
        return records.filter(record => matched.every(p => p.filter(ctx, record)));
    }
    /**
     * 检查用户是否对某条记录有权限
     */
    checkRecord(table, ctx, record) {
        const matched = this.policies.filter(p => p.table === table || p.table === '*');
        if (matched.length === 0)
            return true;
        return matched.every(p => p.filter(ctx, record));
    }
}
exports.RowLevelSecurity = RowLevelSecurity;
//# sourceMappingURL=rls.js.map