/**
 * permission-resolver.ts — GraphEngine 集成的权限解析器
 *
 * 在 GraphEngine 的 upsertNode/deleteNode/query 操作路径中注入权限检查。
 * 桥接现有的 RBAC + RLS 系统，提供 PermissionResolver 接口和
 * wrapEngine() 工厂函数。
 *
 * GAP-38: RBAC 自动集成
 * - PermissionResolver 类: grant/revoke/check 操作
 * - wrapEngine(): 返回 PermissionGuardian — 在操作前检查权限
 * - 集成到现有 roles 模型 (ADMIN / OPERATOR / WRITER / READER)
 */

import { Role, AuthError } from '../types'
import { RBAC } from './rbac'
import { RowLevelSecurity, type RLSContext } from './rls'

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

export type PermissionAction = 'create' | 'read' | 'update' | 'delete' | 'query' | 'admin'

export interface PermissionContext {
  userId: string
  role: Role | string
  tenantId?: string
  properties?: Record<string, unknown>
}

export interface PermissionCheckResult {
  allowed: boolean
  reason?: string
}

/**
 * GraphEngine 操作接口的最小定义 —— wrapEngine 只关心需要保护的方法签名。
 */
export interface GraphEngineOps {
  upsertNode?(nodeId: number, data: { typeId: number; name: string; props?: Record<string, unknown> }, ctx?: PermissionContext): Promise<unknown>
  deleteNode?(nodeId: number, ctx?: PermissionContext): Promise<boolean>
  upsertEdge?(edgeId: number, data: { typeId: number; outNodeId: number; inNodeId: number; props?: Record<string, unknown> }, ctx?: PermissionContext): Promise<unknown>
  deleteEdge?(edgeId: number, ctx?: PermissionContext): Promise<boolean>
  query?(cypher: string, params?: Record<string, unknown>, ctx?: PermissionContext): Promise<unknown>
  [key: string]: unknown
}

export interface PermissionGuardian extends GraphEngineOps {
  /** 底层引擎引用 */
  _engine: GraphEngineOps
  /** 权限解析器引用 */
  _resolver: PermissionResolver

  // Grant/Revoke/Check 管理接口
  grant(ctx: PermissionContext, resource: string, resourceId: string | undefined, action: PermissionAction): void
  revoke(ctx: PermissionContext, resource: string, resourceId: string | undefined): void
  check(ctx: PermissionContext, action: PermissionAction, resource: string, resourceId?: string): PermissionCheckResult

  /** 获取 RLS 实例（用于注册策略） */
  getRLS(): RowLevelSecurity
}

// ──────────────────────────────────────────
// PermissionResolver
// ──────────────────────────────────────────

/**
 * PermissionResolver — 权限解析器
 *
 * 在 GraphEngine 操作前执行 RBAC + RLS 权限检查。
 *
 * 使用方式:
 *   const resolver = new PermissionResolver(rlsInstance)
 *   resolver.grant({ userId: 'u1', role: 'writer' }, 'graph_node', undefined, 'create')
 *   resolver.check({ userId: 'u1', role: 'writer' }, 'create', 'graph_node') // => { allowed: true }
 */
export class PermissionResolver {
  private _rls: RowLevelSecurity

  constructor(rls?: RowLevelSecurity) {
    this._rls = rls ?? new RowLevelSecurity()
  }

  /** 获取 RLS 实例（用于注册策略） */
  getRLS(): RowLevelSecurity {
    return this._rls
  }

  /**
   * 授予用户在指定资源上的操作权限。
   * 底层通过 RBAC.addAcl 添加 ACL 条目。
   */
  grant(
    ctx: PermissionContext,
    resource: string,
    resourceId: string | undefined,
    action: PermissionAction,
  ): void {
    const role = ctx.role as Role
    RBAC.addAcl({
      role,
      resource: resource as any,
      resourceId,
      actions: [action],
    })
  }

  /**
   * 撤销用户在指定资源上的权限。
   * 底层通过 RBAC.removeAcl 删除 ACL 条目。
   */
  revoke(
    ctx: PermissionContext,
    resource: string,
    resourceId: string | undefined,
  ): void {
    const role = ctx.role as Role
    RBAC.removeAcl(role, resource, resourceId)
  }

  /**
   * 检查用户是否对指定资源有操作权限。
   * 使用 RBAC.aclAllows 进行检查，不抛出异常。
   */
  check(
    ctx: PermissionContext,
    action: PermissionAction,
    resource: string,
    resourceId?: string,
  ): PermissionCheckResult {
    const role = ctx.role as Role

    // Admin 始终有权限
    if (role === Role.ADMIN) {
      return { allowed: true }
    }

    const allowed = RBAC.aclAllows(role, action, resource, resourceId)
    if (allowed) {
      return { allowed: true }
    }

    return {
      allowed: false,
      reason: `Role '${ctx.role}' does not have '${action}' permission on '${resource}'${resourceId ? ` (id: ${resourceId})` : ''}`,
    }
  }

  /**
   * 检查节点 upsert 操作是否允许。
   * 先做 RBAC 检查，再做 RLS 检查（如果提供了上下文属性）。
   */
  checkNodeUpsert(
    ctx: PermissionContext,
    nodeId: number,
    data: { typeId: number; name: string; props?: Record<string, unknown> },
  ): PermissionCheckResult {
    // RBAC 检查
    const rbacResult = this.check(ctx, 'create', 'graph_node')
    if (!rbacResult.allowed) return rbacResult

    // RLS 检查（如果上下文有 tenantId 和节点属性）
    if (ctx.tenantId && data.props) {
      const rlsCtx: RLSContext = {
        userId: ctx.userId,
        role: ctx.role as Role,
        tenantId: ctx.tenantId,
        properties: ctx.properties,
      }
      const allowed = this._rls.checkRecord('nodes', rlsCtx, data.props)
      if (!allowed) {
        return { allowed: false, reason: 'RLS denied node upsert' }
      }
    }

    return { allowed: true }
  }

  /**
   * 检查节点删除操作是否允许。
   * 先做 RBAC 检查，再做Optional的 RLS 检查。
   */
  checkNodeDelete(
    ctx: PermissionContext,
    nodeId: number,
    tenantId?: string,
  ): PermissionCheckResult {
    const rbacResult = this.check(ctx, 'delete', 'graph_node')
    if (!rbacResult.allowed) return rbacResult

    if (ctx.tenantId && tenantId) {
      const rlsCtx: RLSContext = {
        userId: ctx.userId,
        role: ctx.role as Role,
        tenantId: ctx.tenantId,
      }
      const allowed = this._rls.checkRecord('nodes', rlsCtx, { tenantId })
      if (!allowed) {
        return { allowed: false, reason: 'RLS denied node delete' }
      }
    }

    return { allowed: true }
  }

  /**
   * 检查边 upsert 操作是否允许。
   */
  checkEdgeUpsert(
    ctx: PermissionContext,
    edgeId: number,
    data: { typeId: number; outNodeId: number; inNodeId: number; props?: Record<string, unknown> },
  ): PermissionCheckResult {
    const rbacResult = this.check(ctx, 'create', 'graph_edge')
    if (!rbacResult.allowed) return rbacResult

    return { allowed: true }
  }

  /**
   * 检查查询操作是否允许。
   */
  checkQuery(
    ctx: PermissionContext,
    cypher: string,
  ): PermissionCheckResult {
    return this.check(ctx, 'query', 'query')
  }

  /**
   * 断言操作允许，否则抛出 AuthError。
   */
  assertAllowed(result: PermissionCheckResult): void {
    if (!result.allowed) {
      throw new AuthError(result.reason ?? 'Permission denied', 403)
    }
  }
}

// ──────────────────────────────────────────
// wrapEngine
// ──────────────────────────────────────────

/**
 * wrapEngine — 将 GraphEngine 包装为 PermissionGuardian。
 *
 * 在 upsertNode / deleteNode / upsertEdge / deleteEdge / query
 * 等入口前注入权限检查，返回一个代理对象。
 *
 * @param engine 原始的 GraphEngine 实例
 * @param resolver PermissionResolver 实例（Optional，默认为新实例）
 * @returns PermissionGuardian 代理
 *
 * 使用方式:
 *   const guardian = wrapEngine(graphEngine, resolver)
 *   await guardian.upsertNode(1, { typeId: 1, name: 'n1' }, { userId: 'u1', role: 'writer' })
 *
 * 向后兼容: 如果不传 ctx 参数，操作跳过权限检查（行为不变）。
 */
export function wrapEngine(
  engine: GraphEngineOps,
  resolver?: PermissionResolver,
): PermissionGuardian {
  const rls = resolver?.getRLS() ?? new RowLevelSecurity()
  const res = resolver ?? new PermissionResolver(rls)

  // 构建代理，在每个方法前检查权限
  const guardian: PermissionGuardian = {
    _engine: engine,
    _resolver: res,

    // ── Grant / Revoke / Check 管理 ──

    grant(
      ctx: PermissionContext,
      resource: string,
      resourceId: string | undefined,
      action: PermissionAction,
    ): void {
      return res.grant(ctx, resource, resourceId, action)
    },

    revoke(
      ctx: PermissionContext,
      resource: string,
      resourceId: string | undefined,
    ): void {
      return res.revoke(ctx, resource, resourceId)
    },

    check(
      ctx: PermissionContext,
      action: PermissionAction,
      resource: string,
      resourceId?: string,
    ): PermissionCheckResult {
      return res.check(ctx, action, resource, resourceId)
    },

    getRLS(): RowLevelSecurity {
      return res.getRLS()
    },

    // ── 受保护的操作 ──

    async upsertNode(
      nodeId: number,
      data: { typeId: number; name: string; props?: Record<string, unknown> },
      ctx?: PermissionContext,
    ): Promise<unknown> {
      if (ctx) {
        res.assertAllowed(res.checkNodeUpsert(ctx, nodeId, data))
      }
      if (engine.upsertNode) {
        return engine.upsertNode(nodeId, data, ctx)
      }
      throw new Error('upsertNode not implemented on engine')
    },

    async deleteNode(nodeId: number, ctx?: PermissionContext): Promise<boolean> {
      if (ctx) {
        res.assertAllowed(res.checkNodeDelete(ctx, nodeId, ctx.tenantId))
      }
      if (engine.deleteNode) {
        return engine.deleteNode(nodeId, ctx)
      }
      throw new Error('deleteNode not implemented on engine')
    },

    async upsertEdge(
      edgeId: number,
      data: { typeId: number; outNodeId: number; inNodeId: number; props?: Record<string, unknown> },
      ctx?: PermissionContext,
    ): Promise<unknown> {
      if (ctx) {
        res.assertAllowed(res.checkEdgeUpsert(ctx, edgeId, data))
      }
      if (engine.upsertEdge) {
        return engine.upsertEdge(edgeId, data, ctx)
      }
      throw new Error('upsertEdge not implemented on engine')
    },

    async deleteEdge(edgeId: number, ctx?: PermissionContext): Promise<boolean> {
      if (ctx) {
        const role = ctx.role as Role
        RBAC.checkAclPermission(role, 'delete', 'graph_edge')
      }
      if (engine.deleteEdge) {
        return engine.deleteEdge(edgeId, ctx)
      }
      throw new Error('deleteEdge not implemented on engine')
    },

    async query(
      cypher: string,
      params?: Record<string, unknown>,
      ctx?: PermissionContext,
    ): Promise<unknown> {
      if (ctx) {
        res.assertAllowed(res.checkQuery(ctx, cypher))
      }
      if (engine.query) {
        return engine.query(cypher, params, ctx)
      }
      throw new Error('query not implemented on engine')
    },
  }

  return guardian
}
