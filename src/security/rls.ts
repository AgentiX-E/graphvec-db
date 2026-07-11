/**
 * rls.ts — 行级安全（Row-Level Security）
 *
 * 在 graph 查询/写入时根据用户上下文过滤数据。
 * 每条策略包含目标表和过滤函数，enforceQuery 在查询结果上应用过滤。
 */

import { Role } from '../types'

export interface RLSContext {
  userId: string
  role: Role
  /** 用户所属租户/组织，用于多租户隔离 */
  tenantId?: string
  /** 附加属性，可用于更细粒度的过滤 */
  properties?: Record<string, unknown>
}

export interface RLSPolicy {
  /** 目标表: 'nodes' | 'edges' | 'graph' | '*' */
  table: string
  /** 策略名称（用于Debug） */
  name: string
  /** 过滤函数：返回 true 表示该记录对用户可见 */
  filter: (ctx: RLSContext, record: unknown) => boolean
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
export class RowLevelSecurity {
  private policies: RLSPolicy[] = []

  /** 添加一条 RLS 策略 */
  addPolicy(p: RLSPolicy): void {
    this.policies.push(p)
  }

  /** 移除一条策略 */
  removePolicy(name: string): boolean {
    const idx = this.policies.findIndex(p => p.name === name)
    if (idx === -1) return false
    this.policies.splice(idx, 1)
    return true
  }

  /** 获取所有策略 */
  getPolicies(): ReadonlyArray<RLSPolicy> {
    return this.policies
  }

  /** 清除所有策略 */
  clear(): void {
    this.policies = []
  }

  /**
   * 对查询结果执行 RLS 过滤
   * @param table 查询的表名
   * @param ctx 用户上下文
   * @param records 原始查询结果
   * @returns 过滤后的结果
   */
  enforceQuery<T>(table: string, ctx: RLSContext, records: T[]): T[] {
    const matched = this.policies.filter(
      p => p.table === table || p.table === '*' || p.table === 'graph'
    )
    if (matched.length === 0) return records
    return records.filter(record => matched.every(p => p.filter(ctx, record)))
  }

  /**
   * 检查用户是否对某条记录有权限
   */
  checkRecord(table: string, ctx: RLSContext, record: unknown): boolean {
    const matched = this.policies.filter(
      p => p.table === table || p.table === '*'
    )
    if (matched.length === 0) return true
    return matched.every(p => p.filter(ctx, record))
  }
}

// ─── C-08: RLS write path ───

/**
 * 检查 upsert 节点是否允许。根据节点数据中的 tenantId 与用户上下文进行校验。
 *
 * @param rls RowLevelSecurity 实例
 * @param ctx 用户上下文
 * @param nodeData 节点数据（包含 typeId, name, props 等）
 * @returns true 表示允许
 */
export function checkRLSUpsertNode(
  rls: RowLevelSecurity,
  ctx: RLSContext,
  nodeData: { typeId: number; name: string; props?: Record<string, unknown> },
): boolean {
  const table = 'nodes'
  const matched = rls.getPolicies().filter(
    p => p.table === table || p.table === '*' || p.table === 'graph',
  )
  if (matched.length === 0) return true
  const record = { ...nodeData.props, id: nodeData.typeId, name: nodeData.name }
  return matched.every(p => p.filter(ctx, record))
}

/**
 * 检查删除节点是否允许。根据 tenantId 与用户上下文进行校验。
 *
 * @param rls RowLevelSecurity 实例
 * @param ctx 用户上下文
 * @param nodeId Node ID
 * @param tenantId 节点所属租户（可为空）
 * @returns true 表示允许
 */
export function checkRLSDeleteNode(
  rls: RowLevelSecurity,
  ctx: RLSContext,
  nodeId: number,
  tenantId?: string,
): boolean {
  const table = 'nodes'
  const matched = rls.getPolicies().filter(
    p => p.table === table || p.table === '*' || p.table === 'graph',
  )
  if (matched.length === 0) return true
  const record = { tenantId }
  return matched.every(p => p.filter(ctx, record))
}

/**
 * 断言 upsert 操作被 RLS 允许。如果不允许则抛出Error。
 *
 * @throws Error 如果 RLS 拒绝了操作
 */
export function assertRLSUpsert(
  rls: RowLevelSecurity,
  ctx: RLSContext,
  table: string,
  props: Record<string, unknown>,
): void {
  const matched = rls.getPolicies().filter(
    p => p.table === table || p.table === '*' || p.table === 'graph',
  )
  if (matched.length === 0) return
  const allowed = matched.every(p => p.filter(ctx, props))
  if (!allowed) {
    throw new Error('RLS denied upsert operation')
  }
}
