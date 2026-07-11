/**
 * tenant-manager.spec.ts — TenantManager 单元测试
 *
 * 测试 CRUD、ACL 集成、单例管理。
 * Note: RBAC 是全局单例，每个 test 前需 clean ACLs。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { RBAC } from './auth'
import {
  TenantManager,
  getDefaultTenantManager,
  setDefaultTenantManager,
  clearDefaultTenantManager,
} from './tenant-manager'

describe('TenantManager', () => {
  let mgr: TenantManager

  beforeEach(() => {
    // 每次测试前创建干净实例 + 清理 RBAC 全局状态
    mgr = new TenantManager()
    RBAC.clearAcls()
  })

  describe('createTenant', () => {
    it('creates a tenant with minimal params', () => {
      const t = mgr.createTenant({ name: 'my-tenant' })
      expect(t.name).toBe('my-tenant')
      expect(t.displayName).toBe('my-tenant')
      expect(t.active).toBe(true)
      expect(t.createdAt).toBeGreaterThan(0)
      expect(t.updatedAt).toBeGreaterThan(0)
    })

    it('creates a tenant with all params', () => {
      const t = mgr.createTenant({
        name: 'acme-corp',
        displayName: 'Acme Corp Data',
        description: 'The main tenant for ACME',
        metadata: { region: 'us-east' },
      })
      expect(t.displayName).toBe('Acme Corp Data')
      expect(t.description).toBe('The main tenant for ACME')
      expect(t.metadata).toEqual({ region: 'us-east' })
    })

    it('throws on duplicate name', () => {
      mgr.createTenant({ name: 'dup' })
      expect(() => mgr.createTenant({ name: 'dup' })).toThrow('already exists')
    })

    it('throws on empty name', () => {
      expect(() => mgr.createTenant({ name: '  ' })).toThrow('required')
    })

    it('uses name as displayName when displayName is empty', () => {
      const t = mgr.createTenant({ name: 'n', displayName: '  ' })
      expect(t.displayName).toBe('n')
    })

    it('creates RBAC ACL entry for creator role', () => {
      const t = mgr.createTenant({ name: 'rbac-test' }, 'admin')
      const acls = RBAC.getAcls().filter(
        a => a.resource === 'subgraph' && a.resourceId === 'rbac-test',
      )
      expect(acls.length).toBeGreaterThan(0)
      expect(acls[0].role).toBe('admin')
      expect(acls[0].actions).toContain('read')
      expect(acls[0].actions).toContain('write')
    })
  })

  describe('getTenant', () => {
    it('returns tenant by name', () => {
      mgr.createTenant({ name: 't1' })
      const t = mgr.getTenant('t1')
      expect(t).toBeDefined()
      expect(t!.name).toBe('t1')
    })

    it('returns undefined for non-existent tenant', () => {
      expect(mgr.getTenant('nonexistent')).toBeUndefined()
    })
  })

  describe('listTenants', () => {
    it('lists all tenants', () => {
      mgr.createTenant({ name: 'a' })
      mgr.createTenant({ name: 'b' })
      expect(mgr.listTenants()).toHaveLength(2)
    })

    it('filters by activeOnly', () => {
      mgr.createTenant({ name: 'active-one' })
      const t2 = mgr.createTenant({ name: 'to-deactivate' })
      mgr.updateTenant('to-deactivate', { active: false })

      const all = mgr.listTenants()
      expect(all).toHaveLength(2)

      const active = mgr.listTenants(true)
      expect(active).toHaveLength(1)
      expect(active[0].name).toBe('active-one')
    })

    it('returns empty array when no tenants', () => {
      expect(mgr.listTenants()).toEqual([])
    })
  })

  describe('updateTenant', () => {
    it('updates displayName', () => {
      mgr.createTenant({ name: 't1' })
      const updated = mgr.updateTenant('t1', { displayName: 'Updated Name' })
      expect(updated.displayName).toBe('Updated Name')
    })

    it('updates description', () => {
      mgr.createTenant({ name: 't1' })
      const updated = mgr.updateTenant('t1', { description: 'new desc' })
      expect(updated.description).toBe('new desc')
    })

    it('updates metadata', () => {
      mgr.createTenant({ name: 't1' })
      const updated = mgr.updateTenant('t1', {
        metadata: { env: 'prod' },
      })
      expect(updated.metadata).toEqual({ env: 'prod' })
    })

    it('deactivates tenant and removes ACLs', () => {
      mgr.createTenant({ name: 't1' }, 'admin')
      mgr.updateTenant('t1', { active: false })
      const t = mgr.getTenant('t1')
      expect(t!.active).toBe(false)

      const acls = RBAC.getAcls().filter(
        a => a.resource === 'subgraph' && a.resourceId === 't1',
      )
      expect(acls).toHaveLength(0)
    })

    it('throws on non-existent tenant', () => {
      expect(() =>
        mgr.updateTenant('missing', { displayName: 'x' }),
      ).toThrow('not found')
    })

    it('updates updatedAt on change', () => {
      mgr.createTenant({ name: 't1' })
      const before = mgr.getTenant('t1')!.updatedAt
      const updated = mgr.updateTenant('t1', { displayName: 'New' })
      expect(updated.updatedAt).toBeGreaterThanOrEqual(before)
    })
  })

  describe('deleteTenant', () => {
    it('deletes existing tenant', () => {
      mgr.createTenant({ name: 'del' })
      expect(mgr.deleteTenant('del')).toBe(true)
      expect(mgr.getTenant('del')).toBeUndefined()
    })

    it('removes ACLs on delete', () => {
      mgr.createTenant({ name: 'del' }, 'editor')
      mgr.deleteTenant('del')
      const acls = RBAC.getAcls().filter(
        a => a.resource === 'subgraph' && a.resourceId === 'del',
      )
      expect(acls).toHaveLength(0)
    })

    it('returns false for non-existent tenant', () => {
      expect(mgr.deleteTenant('nothing')).toBe(false)
    })
  })

  describe('grantAccess / revokeAccess', () => {
    it('grants access to a tenant', () => {
      mgr.createTenant({ name: 't1' })
      mgr.grantAccess('t1', 'viewer', ['read'])
      const access = mgr.listAccess('t1')
      expect(access.some(a => a.role === 'viewer' && a.actions.includes('read'))).toBe(true)
    })

    it('revokes access from a tenant', () => {
      mgr.createTenant({ name: 't1' })
      mgr.grantAccess('t1', 'viewer', ['read'])
      expect(mgr.revokeAccess('t1', 'viewer')).toBe(true)
      const access = mgr.listAccess('t1')
      expect(access.some(a => a.role === 'viewer')).toBe(false)
    })

    it('grantAccess throws on non-existent tenant', () => {
      expect(() => mgr.grantAccess('missing', 'r', ['read'])).toThrow('not found')
    })

    it('revokeAccess returns false for non-existent tenant', () => {
      expect(mgr.revokeAccess('missing', 'r')).toBe(false)
    })
  })

  describe('listAccess', () => {
    it('lists all roles accessing a tenant', () => {
      mgr.createTenant({ name: 't1' }, 'owner')
      mgr.grantAccess('t1', 'editor', ['read', 'write'])
      mgr.grantAccess('t1', 'viewer', ['read'])

      const access = mgr.listAccess('t1')
      expect(access).toHaveLength(3) // owner (auto) + editor + viewer
    })

    it('returns empty array for tenant with no explicit access', () => {
      mgr.createTenant({ name: 't1' })
      // 清理默认创建的 ACL
      RBAC.removeAcl('*', 'subgraph', 't1')
      expect(mgr.listAccess('t1')).toEqual([])
    })
  })

  describe('count / exists', () => {
    it('returns count of tenants', () => {
      expect(mgr.count).toBe(0)
      mgr.createTenant({ name: 'a' })
      expect(mgr.count).toBe(1)
      mgr.createTenant({ name: 'b' })
      expect(mgr.count).toBe(2)
    })

    it('exists returns true for existing tenant', () => {
      mgr.createTenant({ name: 't1' })
      expect(mgr.exists('t1')).toBe(true)
      expect(mgr.exists('missing')).toBe(false)
    })
  })

  describe('reset', () => {
    it('clears all tenants and their ACLs', () => {
      mgr.createTenant({ name: 'a' })
      mgr.createTenant({ name: 'b' })
      mgr.reset()
      expect(mgr.count).toBe(0)
      expect(mgr.listTenants()).toEqual([])
    })
  })

  describe('TenantConfig defaultActions', () => {
    it('uses custom defaultActions from config', () => {
      const customMgr = new TenantManager({ defaultActions: ['admin'] })
      customMgr.createTenant({ name: 't1' }, 'superuser')
      const acls = RBAC.getAcls().filter(
        a => a.resource === 'subgraph' && a.resourceId === 't1',
      )
      expect(acls[0].actions).toEqual(['admin'])
    })
  })
})

describe('default TenantManager singleton', () => {
  afterEach(() => {
    clearDefaultTenantManager()
  })

  it('getDefaultTenantManager creates and returns same instance', () => {
    const mgr1 = getDefaultTenantManager()
    const mgr2 = getDefaultTenantManager()
    expect(mgr1).toBe(mgr2)
  })

  it('setDefaultTenantManager overrides the instance', () => {
    const custom = new TenantManager()
    setDefaultTenantManager(custom)
    expect(getDefaultTenantManager()).toBe(custom)
  })

  it('clearDefaultTenantManager allows recreation', () => {
    const mgr1 = getDefaultTenantManager()
    clearDefaultTenantManager()
    const mgr2 = getDefaultTenantManager()
    expect(mgr1).not.toBe(mgr2)
  })
})
