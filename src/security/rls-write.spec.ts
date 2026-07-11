/**
 * C-08: RLS write 路径覆盖 — 测试
 *
 * 验证 RLS 注入 upsertNode/deleteNode
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { RowLevelSecurity, RLSContext, checkRLSUpsertNode, checkRLSDeleteNode, assertRLSUpsert } from './rls'
import { Role } from '../types'

describe('C-08: RLS write path coverage', () => {
  let rls: RowLevelSecurity
  let adminCtx: RLSContext
  let tenantACtx: RLSContext
  let tenantBCtx: RLSContext

  beforeEach(() => {
    rls = new RowLevelSecurity()
    adminCtx = { userId: 'admin', role: Role.ADMIN }
    tenantACtx = { userId: 'user-a', role: Role.WRITER, tenantId: 'tenant-A' }
    tenantBCtx = { userId: 'user-b', role: Role.WRITER, tenantId: 'tenant-B' }

    // Add tenant isolation policy
    rls.addPolicy({
      table: 'nodes',
      name: 'tenant-isolation',
      filter: (ctx, record: any) => {
        // Admin sees everything
        if (ctx.role === Role.ADMIN) return true
        // Non-admin: only see own tenant data
        return !ctx.tenantId || record.tenantId === ctx.tenantId
      },
    })
    rls.addPolicy({
      table: 'edges',
      name: 'tenant-edge-isolation',
      filter: (ctx, record: any) => {
        if (ctx.role === Role.ADMIN) return true
        return !ctx.tenantId || record.tenantId === ctx.tenantId
      },
    })
  })

  // TC1: RLS upsertNode — 允许
  it('checkRLSUpsertNode allows same tenant write', () => {
    const result = checkRLSUpsertNode(rls, tenantACtx, {
      typeId: 1,
      name: 'NodeA',
      props: { tenantId: 'tenant-A' },
    })
    expect(result).toBe(true)
  })

  // TC2: RLS upsertNode — 拒绝跨租户写入
  it('checkRLSUpsertNode denies cross-tenant write', () => {
    // tenant-B tries to write node belonging to tenant-A
    const result = checkRLSUpsertNode(rls, tenantBCtx, {
      typeId: 1,
      name: 'NodeA',
      props: { tenantId: 'tenant-A' },
    })
    expect(result).toBe(false)
  })

  // TC3: RLS upsertNode — admin 可以跨租户写入
  it('checkRLSUpsertNode admin bypasses tenant check', () => {
    const result = checkRLSUpsertNode(rls, adminCtx, {
      typeId: 1,
      name: 'NodeA',
      props: { tenantId: 'tenant-A' },
    })
    expect(result).toBe(true)
  })

  // TC4: RLS deleteNode — 允许
  it('checkRLSDeleteNode with matching tenant', () => {
    const result = checkRLSDeleteNode(rls, tenantACtx, 123, 'tenant-A')
    expect(result).toBe(true)
  })

  // TC5: RLS deleteNode — 拒绝
  it('checkRLSDeleteNode with non-matching tenant', () => {
    const result = checkRLSDeleteNode(rls, tenantBCtx, 123, 'tenant-A')
    expect(result).toBe(false)
  })

  // TC6: RLS deleteNode — admin 绕过
  it('checkRLSDeleteNode admin bypass', () => {
    const result = checkRLSDeleteNode(rls, adminCtx, 123, 'tenant-A')
    expect(result).toBe(true)
  })

  // TC7: assertRLSUpsert 抛出 RLS Error
  it('assertRLSUpsert throws on denied write', () => {
    expect(() => {
      assertRLSUpsert(rls, tenantBCtx, 'nodes', { tenantId: 'tenant-A' })
    }).toThrow('RLS denied')

    // Admin should not throw
    expect(() => {
      assertRLSUpsert(rls, adminCtx, 'nodes', { tenantId: 'tenant-A' })
    }).not.toThrow()
  })

  // TC8: 无策略时所有操作允许
  it('checkRLSUpsertNode allows all when no policies', () => {
    const emptyRls = new RowLevelSecurity()
    const result = checkRLSUpsertNode(emptyRls, tenantACtx, {
      typeId: 1,
      name: 'AnyNode',
    })
    expect(result).toBe(true)
  })
})
