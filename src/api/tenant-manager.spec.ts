// ============================================================
// tenant-manager.spec.ts — TenantManager unit tests
// ============================================================
// Tests for the tenant manager (GAP-54): CRUD, ACL integration,
// permission checks, edge cases.
// ============================================================

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { TenantManager, getDefaultTenantManager, clearDefaultTenantManager, setDefaultTenantManager } from '../security/tenant-manager'
import { RBAC } from '../security/auth'

describe('TenantManager', () => {
  let mgr: TenantManager

  beforeEach(() => {
    mgr = new TenantManager()
    RBAC.clearAcls()
  })

  afterAll(() => {
    RBAC.clearAcls()
  })

  // ── CRUD ────────────────────────────────────────────

  describe('CRUD operations', () => {
    it('should create a tenant with minimal fields', () => {
      const tenant = mgr.createTenant({ name: 'tenant-1' })
      expect(tenant.name).toBe('tenant-1')
      expect(tenant.displayName).toBe('tenant-1') // defaults to name
      expect(tenant.active).toBe(true)
      expect(tenant.createdAt).toBeGreaterThan(0)
      expect(tenant.updatedAt).toBeGreaterThan(0)
    })

    it('should create a tenant with all fields', () => {
      const tenant = mgr.createTenant({
        name: '  sales-db  ',
        displayName: 'Sales Database',
        description: 'Contains all sales records',
        metadata: { team: 'sales', env: 'prod' },
      })
      expect(tenant.name).toBe('sales-db') // trimmed
      expect(tenant.displayName).toBe('Sales Database')
      expect(tenant.description).toBe('Contains all sales records')
      expect(tenant.metadata).toEqual({ team: 'sales', env: 'prod' })
    })

    it('should reject creating a tenant with empty name', () => {
      expect(() => mgr.createTenant({ name: '' })).toThrow('Tenant name is required')
      expect(() => mgr.createTenant({ name: '   ' })).toThrow('Tenant name is required')
    })

    it('should reject creating a duplicate tenant', () => {
      mgr.createTenant({ name: 'dup' })
      expect(() => mgr.createTenant({ name: 'dup' })).toThrow(/already exists/)
    })

    it('should get a tenant by name', () => {
      mgr.createTenant({ name: 'my-tenant' })
      const t = mgr.getTenant('my-tenant')
      expect(t).toBeDefined()
      expect(t!.name).toBe('my-tenant')
    })

    it('should return undefined for unknown tenant', () => {
      expect(mgr.getTenant('nonexistent')).toBeUndefined()
    })

    it('should list all tenants', () => {
      mgr.createTenant({ name: 'a' })
      mgr.createTenant({ name: 'b' })
      mgr.createTenant({ name: 'c' })
      const tenants = mgr.listTenants()
      expect(tenants).toHaveLength(3)
      expect(tenants.map(t => t.name)).toContain('a')
      expect(tenants.map(t => t.name)).toContain('b')
      expect(tenants.map(t => t.name)).toContain('c')
    })

    it('should list active tenants only', () => {
      mgr.createTenant({ name: 'active-1' })
      mgr.createTenant({ name: 'active-2' })
      mgr.updateTenant('active-2', { active: false })
      const active = mgr.listTenants(true)
      expect(active).toHaveLength(1)
      expect(active[0].name).toBe('active-1')
    })

    it('should update a tenant', () => {
      mgr.createTenant({ name: 't1', description: 'old' })
      const updated = mgr.updateTenant('t1', {
        displayName: 'Updated',
        description: 'new desc',
        metadata: { key: 'val' },
      })
      expect(updated.displayName).toBe('Updated')
      expect(updated.description).toBe('new desc')
      expect(updated.metadata).toEqual({ key: 'val' })
      expect(updated.updatedAt).toBeGreaterThan(updated.createdAt)
    })

    it('should deactivate a tenant', () => {
      mgr.createTenant({ name: 't1' })
      const deactivated = mgr.updateTenant('t1', { active: false })
      expect(deactivated.active).toBe(false)
    })

    it('should throw on updating unknown tenant', () => {
      expect(() => mgr.updateTenant('nope', { displayName: 'x' })).toThrow(/not found/)
    })

    it('should delete a tenant', () => {
      mgr.createTenant({ name: 'delete-me' })
      expect(mgr.deleteTenant('delete-me')).toBe(true)
      expect(mgr.getTenant('delete-me')).toBeUndefined()
    })

    it('should return false when deleting unknown tenant', () => {
      expect(mgr.deleteTenant('nonexistent')).toBe(false)
    })

    it('should detect existence', () => {
      mgr.createTenant({ name: 'exists' })
      expect(mgr.exists('exists')).toBe(true)
      expect(mgr.exists('no-exists')).toBe(false)
    })

    it('should report correct count', () => {
      expect(mgr.count).toBe(0)
      mgr.createTenant({ name: 'a' })
      expect(mgr.count).toBe(1)
      mgr.createTenant({ name: 'b' })
      expect(mgr.count).toBe(2)
      mgr.deleteTenant('a')
      expect(mgr.count).toBe(1)
    })
  })

  // ── ACL Integration (RBAC) ──────────────────────────

  describe('RBAC ACL integration', () => {
    it('should create subgraph ACL when creating tenant', () => {
      mgr.createTenant({ name: 'sg1' })
      const acls = RBAC.getAcls()
      const subgraphAcls = acls.filter(e => e.resource === 'subgraph' && e.resourceId === 'sg1')
      expect(subgraphAcls).toHaveLength(1)
      expect(subgraphAcls[0].role).toBe('*')
    })

    it('should remove subgraph ACL when deleting tenant', () => {
      mgr.createTenant({ name: 'sg1' })
      mgr.deleteTenant('sg1')
      const acls = RBAC.getAcls().filter(e => e.resource === 'subgraph' && e.resourceId === 'sg1')
      expect(acls).toHaveLength(0)
    })

    it('should grant access to a role', () => {
      mgr.createTenant({ name: 'sg1' })
      mgr.grantAccess('sg1', 'admin', ['admin'])
      const access = mgr.listAccess('sg1')
      expect(access.some(a => a.role === 'admin')).toBe(true)
    })

    it('should revoke access from a role', () => {
      mgr.createTenant({ name: 'sg1' })
      mgr.grantAccess('sg1', 'admin', ['admin'])
      const removed = mgr.revokeAccess('sg1', 'admin')
      expect(removed).toBe(true)
      const access = mgr.listAccess('sg1')
      expect(access.some(a => a.role === 'admin')).toBe(false)
    })

    it('should return false when revoking non-existent ACL', () => {
      mgr.createTenant({ name: 'sg1' })
      expect(mgr.revokeAccess('sg1', 'nobody')).toBe(false)
    })

    it('should throw when granting access to non-existent tenant', () => {
      expect(() => mgr.grantAccess('nope', 'admin', ['read'])).toThrow(/not found/)
    })

    it('should list ACLs for a tenant', () => {
      mgr.createTenant({ name: 'sg1' })
      mgr.grantAccess('sg1', 'reader', ['read'])
      mgr.grantAccess('sg1', 'writer', ['read', 'write'])
      const access = mgr.listAccess('sg1')
      expect(access).toHaveLength(3) // * + reader + writer
      const writerAcl = access.find(a => a.role === 'writer')
      expect(writerAcl).toBeDefined()
      expect(writerAcl!.actions).toContain('read')
      expect(writerAcl!.actions).toContain('write')
    })
  })

  // ── Permission Check ────────────────────────────────

  describe('checkPermission', () => {
    it('should allow access when ACL grants permission', () => {
      mgr.createTenant({ name: 'sg1' })
      expect(() => mgr.checkPermission('*', 'sg1', 'read')).not.toThrow()
    })

    it('should deny access when no ACL exists for subgraph', () => {
      // Clean up: remove default ACLs
      RBAC.clearAcls()
      expect(() => mgr.checkPermission('READER', 'no-acl', 'read')).toThrow()
    })

    it('should allow admin role regardless of ACL', () => {
      RBAC.clearAcls()
      expect(() => mgr.checkPermission('ADMIN', 'anything', 'delete')).not.toThrow()
    })
  })

  // ── Singleton / Default Manager ─────────────────────

  describe('default tenant manager singleton', () => {
    it('should provide a default singleton', () => {
      clearDefaultTenantManager()
      const singleton = getDefaultTenantManager()
      expect(singleton).toBeDefined()
      expect(singleton).toBeInstanceOf(TenantManager)
    })

    it('should reuse the same instance', () => {
      clearDefaultTenantManager()
      const a = getDefaultTenantManager()
      const b = getDefaultTenantManager()
      expect(a).toBe(b)
    })

    it('should allow setting a custom manager', () => {
      const custom = new TenantManager()
      setDefaultTenantManager(custom)
      expect(getDefaultTenantManager()).toBe(custom)
    })
  })

  // ── Reset ───────────────────────────────────────────

  describe('reset', () => {
    it('should clear all tenants and subgraph ACLs', () => {
      mgr.createTenant({ name: 'a' })
      mgr.createTenant({ name: 'b' })
      expect(mgr.count).toBe(2)
      mgr.reset()
      expect(mgr.count).toBe(0)
      // ACLs should also be cleaned
      const acls = RBAC.getAcls().filter(e => e.resource === 'subgraph')
      expect(acls).toHaveLength(0)
    })
  })

  // ── Edge Cases ──────────────────────────────────────

  describe('edge cases', () => {
    it('should trim whitespace from tenant names', () => {
      const t = mgr.createTenant({ name: '  hello-world  ' })
      expect(t.name).toBe('hello-world')
    })

    it('should handle empty display name by falling back to tenant name', () => {
      const t = mgr.createTenant({ name: 'fallback', displayName: '' })
      expect(t.displayName).toBe('fallback')
    })

    it('should handle many tenants', () => {
      for (let i = 0; i < 100; i++) {
        mgr.createTenant({ name: `tenant-${i}` })
      }
      expect(mgr.count).toBe(100)
      const tenants = mgr.listTenants()
      expect(tenants).toHaveLength(100)
    })

    it('should handle grant/revoke cycle', () => {
      mgr.createTenant({ name: 'cycle' })
      const actions = ['read']
      mgr.grantAccess('cycle', 'reader', actions)
      expect(mgr.listAccess('cycle').some(a => a.role === 'reader')).toBe(true)
      mgr.revokeAccess('cycle', 'reader')
      expect(mgr.listAccess('cycle').some(a => a.role === 'reader')).toBe(false)
      // Re-grant should work
      mgr.grantAccess('cycle', 'reader', ['read', 'write'])
      expect(mgr.listAccess('cycle').some(a => a.role === 'reader')).toBe(true)
    })
  })
})
