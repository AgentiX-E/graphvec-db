/**
 * subgraph-permission.spec.ts — Subgraph ACL permission tests
 *
 * Tests for the RBAC subgraph permission checks (GAP-05 supplement).
 * Uses the RBAC class directly with subgraph ACL entries.
 */
import { RBAC } from './rbac'
import { Role, AuthError } from '../types'
import { LdapAuthenticator, SubgraphPermission } from './auth'

describe('RBAC — Subgraph Permissions', () => {
  // Ensure clean state before each test
  beforeEach(() => {
    RBAC.clearAcls()
  })

  afterAll(() => {
    RBAC.clearAcls()
  })

  describe('checkSubgraphPermission', () => {
    test('should allow access when ACL grants read on subgraph', () => {
      RBAC.addAcl({
        role: Role.READER,
        resource: 'subgraph',
        resourceId: 'my-subgraph',
        actions: ['read'],
      })

      expect(() =>
        RBAC.checkSubgraphPermission(Role.READER, 'my-subgraph', 'read'),
      ).not.toThrow()
    })

    test('should deny access when ACL does not grant the action', () => {
      RBAC.addAcl({
        role: Role.READER,
        resource: 'subgraph',
        resourceId: 'my-subgraph',
        actions: ['read'],
      })

      expect(() =>
        RBAC.checkSubgraphPermission(Role.READER, 'my-subgraph', 'write'),
      ).toThrow(AuthError)
    })

    test('should throw AuthError with statusCode 403 for denied access', () => {
      RBAC.addAcl({
        role: Role.READER,
        resource: 'subgraph',
        resourceId: 'restricted-subgraph',
        actions: ['read'],
      })

      try {
        RBAC.checkSubgraphPermission(Role.READER, 'restricted-subgraph', 'write')
        fail('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(AuthError)
        expect((e as AuthError).statusCode).toBe(403)
        expect((e as AuthError).message).toContain('restricted-subgraph')
        expect((e as AuthError).message).toContain('write')
      }
    })

    test('should allow admin role regardless of ACL on subgraph', () => {
      // No ACLs defined at all — admin should still pass
      expect(() =>
        RBAC.checkSubgraphPermission(Role.ADMIN, 'any-subgraph', 'delete'),
      ).not.toThrow()

      expect(() =>
        RBAC.checkSubgraphPermission(Role.ADMIN, 'secret-subgraph', 'admin'),
      ).not.toThrow()
    })

    test('should deny access when no ACLs defined for subgraph (no fallback for subgraph)', () => {
      // No subgraph ACLs defined at all — should be denied even for READER read
      // (subgraph access is opt-in, no role-based fallback)
      expect(() =>
        RBAC.checkSubgraphPermission(Role.READER, 'unconfigured-subgraph', 'read'),
      ).toThrow(AuthError)

      expect(() =>
        RBAC.checkSubgraphPermission(Role.WRITER, 'unconfigured-subgraph', 'write'),
      ).toThrow(AuthError)
    })

    test('should deny access when ACLs exist for other subgraphs but not this one', () => {
      RBAC.addAcl({
        role: Role.READER,
        resource: 'subgraph',
        resourceId: 'public-subgraph',
        actions: ['read'],
      })

      expect(() =>
        RBAC.checkSubgraphPermission(Role.READER, 'other-subgraph', 'read'),
      ).toThrow(AuthError)
    })

    test('should distinguish between different subgraphs', () => {
      RBAC.addAcl({
        role: Role.READER,
        resource: 'subgraph',
        resourceId: 'public-subgraph',
        actions: ['read'],
      })

      // Allowed on public-subgraph
      expect(() =>
        RBAC.checkSubgraphPermission(Role.READER, 'public-subgraph', 'read'),
      ).not.toThrow()

      // Denied on different subgraph
      expect(() =>
        RBAC.checkSubgraphPermission(Role.READER, 'private-subgraph', 'read'),
      ).toThrow(AuthError)
    })

    test('should allow read/write with admin action ACL on subgraph', () => {
      RBAC.addAcl({
        role: 'subgraph-operator',
        resource: 'subgraph',
        resourceId: 'managed-subgraph',
        actions: ['admin'],
      })

      // Admin action should grant all
      expect(() =>
        RBAC.checkSubgraphPermission('subgraph-operator', 'managed-subgraph', 'read'),
      ).not.toThrow()
      expect(() =>
        RBAC.checkSubgraphPermission('subgraph-operator', 'managed-subgraph', 'write'),
      ).not.toThrow()
      expect(() =>
        RBAC.checkSubgraphPermission('subgraph-operator', 'managed-subgraph', 'admin'),
      ).not.toThrow()
    })

    test('should allow wildcard role (*) to match any role', () => {
      RBAC.addAcl({
        role: '*',
        resource: 'subgraph',
        resourceId: 'shared-subgraph',
        actions: ['read'],
      })

      // Any role with wildcard ACL should pass
      expect(() =>
        RBAC.checkSubgraphPermission(Role.READER, 'shared-subgraph', 'read'),
      ).not.toThrow()
      expect(() =>
        RBAC.checkSubgraphPermission(Role.WRITER, 'shared-subgraph', 'read'),
      ).not.toThrow()

      // But not write (not in ACL actions)
      expect(() =>
        RBAC.checkSubgraphPermission(Role.READER, 'shared-subgraph', 'write'),
      ).toThrow(AuthError)
    })

    test('should allow multiple roles on the same subgraph with different permissions', () => {
      RBAC.addAcl({
        role: Role.READER,
        resource: 'subgraph',
        resourceId: 'mixed-subgraph',
        actions: ['read'],
      })

      RBAC.addAcl({
        role: Role.WRITER,
        resource: 'subgraph',
        resourceId: 'mixed-subgraph',
        actions: ['read', 'write'],
      })

      // Reader can only read
      expect(() =>
        RBAC.checkSubgraphPermission(Role.READER, 'mixed-subgraph', 'read'),
      ).not.toThrow()
      expect(() =>
        RBAC.checkSubgraphPermission(Role.READER, 'mixed-subgraph', 'write'),
      ).toThrow(AuthError)

      // Writer can read and write
      expect(() =>
        RBAC.checkSubgraphPermission(Role.WRITER, 'mixed-subgraph', 'read'),
      ).not.toThrow()
      expect(() =>
        RBAC.checkSubgraphPermission(Role.WRITER, 'mixed-subgraph', 'write'),
      ).not.toThrow()
    })
  })

  describe('getSubgraphAcls', () => {
    test('should return empty array when no ACLs exist for subgraph', () => {
      const acls = RBAC.getSubgraphAcls('nonexistent')
      expect(acls).toEqual([])
    })

    test('should return ACL entries for a specific subgraph', () => {
      RBAC.addAcl({
        role: Role.READER,
        resource: 'subgraph',
        resourceId: 'test-subgraph',
        actions: ['read'],
      })
      RBAC.addAcl({
        role: Role.WRITER,
        resource: 'subgraph',
        resourceId: 'test-subgraph',
        actions: ['read', 'write'],
      })
      RBAC.addAcl({
        role: Role.READER,
        resource: 'subgraph',
        resourceId: 'other-subgraph',
        actions: ['read'],
      })

      const acls = RBAC.getSubgraphAcls('test-subgraph')
      expect(acls).toHaveLength(2)
      expect(acls.every(e => e.resource === 'subgraph')).toBe(true)
      expect(acls.every(e => e.resourceId === 'test-subgraph')).toBe(true)
    })

    test('should not return non-subgraph ACLs', () => {
      RBAC.addAcl({
        role: Role.READER,
        resource: 'database',
        resourceId: 'db1',
        actions: ['read'],
      })
      RBAC.addAcl({
        role: Role.READER,
        resource: 'subgraph',
        resourceId: 'sg1',
        actions: ['read'],
      })

      const acls = RBAC.getSubgraphAcls('sg1')
      expect(acls).toHaveLength(1)
      expect(acls[0].resource).toBe('subgraph')
      expect(acls[0].resourceId).toBe('sg1')
    })
  })

  describe('AclResourceType includes subgraph', () => {
    test('should be able to create subgraph ACL entries via addAcl', () => {
      RBAC.addAcl({
        role: Role.READER,
        resource: 'subgraph',
        resourceId: 'sg1',
        actions: ['read'],
      })

      const allAcls = RBAC.getAcls()
      const subgraphAcls = allAcls.filter(e => e.resource === 'subgraph')
      expect(subgraphAcls).toHaveLength(1)
      expect(subgraphAcls[0].resourceId).toBe('sg1')
    })
  })
})

describe('LdapAuthenticator — Subgraph Permissions', () => {
  let ldap: LdapAuthenticator

  beforeEach(() => {
    ldap = new LdapAuthenticator({
      url: 'ldap://localhost:389',
      bindDn: 'cn=admin,dc=test,dc=com',
      bindPassword: 'test',
      baseDn: 'dc=test,dc=com',
      userFilter: '(uid={{username}})',
      allowMock: true,
    })
  })

  afterEach(() => {
    ldap.clearSubgraphPermissions()
  })

  test('addSubgraphPermission and checkSubgraphPermission', () => {
    const perm: SubgraphPermission = {
      userId: 'alice',
      subgraph: 'sales-db',
      actions: ['read', 'write'],
    }
    ldap.addSubgraphPermission(perm)

    expect(ldap.checkSubgraphPermission('alice', 'sales-db', 'read')).toBe(true)
    expect(ldap.checkSubgraphPermission('alice', 'sales-db', 'write')).toBe(true)
    expect(ldap.checkSubgraphPermission('alice', 'sales-db', 'admin')).toBe(false)
    expect(ldap.checkSubgraphPermission('bob', 'sales-db', 'read')).toBe(false)
    expect(ldap.checkSubgraphPermission('alice', 'other-db', 'read')).toBe(false)
  })

  test('removeSubgraphPermission removes all actions for user+subgraph', () => {
    ldap.addSubgraphPermission({
      userId: 'alice',
      subgraph: 'sg1',
      actions: ['read'],
    })
    expect(ldap.checkSubgraphPermission('alice', 'sg1', 'read')).toBe(true)

    const removed = ldap.removeSubgraphPermission('alice', 'sg1')
    expect(removed).toBe(true)
    expect(ldap.checkSubgraphPermission('alice', 'sg1', 'read')).toBe(false)
  })

  test('getUserSubgraphPermissions returns only owned permissions', () => {
    ldap.addSubgraphPermission({ userId: 'alice', subgraph: 'sg1', actions: ['read'] })
    ldap.addSubgraphPermission({ userId: 'alice', subgraph: 'sg2', actions: ['read', 'write'] })
    ldap.addSubgraphPermission({ userId: 'bob', subgraph: 'sg1', actions: ['admin'] })

    const alicePerms = ldap.getUserSubgraphPermissions('alice')
    expect(alicePerms).toHaveLength(2)
    expect(alicePerms.some(p => p.subgraph === 'sg1')).toBe(true)
    expect(alicePerms.some(p => p.subgraph === 'sg2')).toBe(true)

    const bobPerms = ldap.getUserSubgraphPermissions('bob')
    expect(bobPerms).toHaveLength(1)
    expect(bobPerms[0].subgraph).toBe('sg1')
  })

  test('getAllSubgraphPermissions returns all entries', () => {
    ldap.addSubgraphPermission({ userId: 'alice', subgraph: 'sg1', actions: ['read'] })
    ldap.addSubgraphPermission({ userId: 'bob', subgraph: 'sg2', actions: ['write'] })

    const all = ldap.getAllSubgraphPermissions()
    expect(all).toHaveLength(2)
  })

  test('admin action in subgraph grants all', () => {
    ldap.addSubgraphPermission({ userId: 'alice', subgraph: 'sg1', actions: ['admin'] })

    expect(ldap.checkSubgraphPermission('alice', 'sg1', 'read')).toBe(true)
    expect(ldap.checkSubgraphPermission('alice', 'sg1', 'write')).toBe(true)
    expect(ldap.checkSubgraphPermission('alice', 'sg1', 'admin')).toBe(true)
  })

  test('clearSubgraphPermissions resets all', () => {
    ldap.addSubgraphPermission({ userId: 'alice', subgraph: 'sg1', actions: ['read'] })
    ldap.clearSubgraphPermissions()
    expect(ldap.getAllSubgraphPermissions()).toHaveLength(0)
  })
})
