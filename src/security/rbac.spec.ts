import { RBAC } from './auth'
import { Role, AuthError } from '../types'

describe('RBAC', () => {
  describe('ADMIN role', () => {
    test('should have all permissions (checkPermission does not throw)', () => {
      expect(() => RBAC.checkPermission(Role.ADMIN, 'read')).not.toThrow()
      expect(() => RBAC.checkPermission(Role.ADMIN, 'write')).not.toThrow()
      expect(() => RBAC.checkPermission(Role.ADMIN, 'delete')).not.toThrow()
      expect(() => RBAC.checkPermission(Role.ADMIN, 'compact')).not.toThrow()
      expect(() => RBAC.checkPermission(Role.ADMIN, 'backup')).not.toThrow()
      expect(() => RBAC.checkPermission(Role.ADMIN, 'restore')).not.toThrow()
      expect(() => RBAC.checkPermission(Role.ADMIN, 'reshard')).not.toThrow()
      expect(() => RBAC.checkPermission(Role.ADMIN, 'health')).not.toThrow()
      expect(() => RBAC.checkPermission(Role.ADMIN, 'audit')).not.toThrow()
    })

    test('should have access to all resources', () => {
      expect(() => RBAC.checkResourceAccess(Role.ADMIN, 'write:graph')).not.toThrow()
      expect(() => RBAC.checkResourceAccess(Role.ADMIN, 'read:graph')).not.toThrow()
    })

    test('getPermissions should return [* (all)]', () => {
      const perms = RBAC.getPermissions(Role.ADMIN)
      expect(perms).toEqual(['* (all)'])
    })
  })

  describe('READER role', () => {
    test('should be able to read', () => {
      expect(() => RBAC.checkPermission(Role.READER, 'read')).not.toThrow()
    })

    test('should NOT be able to write', () => {
      expect(() => RBAC.checkPermission(Role.READER, 'write')).toThrow(AuthError)
    })

    test('should NOT be able to delete', () => {
      expect(() => RBAC.checkPermission(Role.READER, 'delete')).toThrow(AuthError)
    })

    test('should NOT be able to compact', () => {
      expect(() => RBAC.checkPermission(Role.READER, 'compact')).toThrow(AuthError)
    })

    test('should NOT be able to backup', () => {
      expect(() => RBAC.checkPermission(Role.READER, 'backup')).toThrow(AuthError)
    })

    test('checkResourceAccess should reject write resources', () => {
      expect(() => RBAC.checkResourceAccess(Role.READER, 'write:data')).toThrow(AuthError)
    })

    test('checkResourceAccess should allow read resources', () => {
      expect(() => RBAC.checkResourceAccess(Role.READER, 'read:data')).not.toThrow()
    })

    test('getPermissions should list only read', () => {
      const perms = RBAC.getPermissions(Role.READER)
      expect(perms).toEqual(['read'])
    })
  })

  describe('WRITER role', () => {
    test('should be able to read', () => {
      expect(() => RBAC.checkPermission(Role.WRITER, 'read')).not.toThrow()
    })

    test('should be able to write', () => {
      expect(() => RBAC.checkPermission(Role.WRITER, 'write')).not.toThrow()
    })

    test('should be able to delete', () => {
      expect(() => RBAC.checkPermission(Role.WRITER, 'delete')).not.toThrow()
    })

    test('should NOT be able to compact', () => {
      expect(() => RBAC.checkPermission(Role.WRITER, 'compact')).toThrow(AuthError)
    })

    test('should NOT be able to backup', () => {
      expect(() => RBAC.checkPermission(Role.WRITER, 'backup')).toThrow(AuthError)
    })

    test('should NOT be able to restore', () => {
      expect(() => RBAC.checkPermission(Role.WRITER, 'restore')).toThrow(AuthError)
    })

    test('should NOT be able to reshard', () => {
      expect(() => RBAC.checkPermission(Role.WRITER, 'reshard')).toThrow(AuthError)
    })

    test('should NOT be able to run health checks', () => {
      expect(() => RBAC.checkPermission(Role.WRITER, 'health')).toThrow(AuthError)
    })

    test('getPermissions should list read, write, delete', () => {
      const perms = RBAC.getPermissions(Role.WRITER)
      expect(perms).toEqual(['read', 'write', 'delete'])
    })
  })

  describe('OPERATOR role', () => {
    test('should be able to read', () => {
      expect(() => RBAC.checkPermission(Role.OPERATOR, 'read')).not.toThrow()
    })

    test('should be able to write', () => {
      expect(() => RBAC.checkPermission(Role.OPERATOR, 'write')).not.toThrow()
    })

    test('should be able to delete', () => {
      expect(() => RBAC.checkPermission(Role.OPERATOR, 'delete')).not.toThrow()
    })

    test('should be able to compact', () => {
      expect(() => RBAC.checkPermission(Role.OPERATOR, 'compact')).not.toThrow()
    })

    test('should be able to backup', () => {
      expect(() => RBAC.checkPermission(Role.OPERATOR, 'backup')).not.toThrow()
    })

    test('should be able to restore', () => {
      expect(() => RBAC.checkPermission(Role.OPERATOR, 'restore')).not.toThrow()
    })

    test('should be able to reshard', () => {
      expect(() => RBAC.checkPermission(Role.OPERATOR, 'reshard')).not.toThrow()
    })

    test('should be able to check health', () => {
      expect(() => RBAC.checkPermission(Role.OPERATOR, 'health')).not.toThrow()
    })

    test('should be able to read metrics', () => {
      expect(() => RBAC.checkPermission(Role.OPERATOR, 'metrics')).not.toThrow()
    })

    test('should be able to read audit logs', () => {
      expect(() => RBAC.checkPermission(Role.OPERATOR, 'audit')).not.toThrow()
    })

    test('getPermissions should list all operator capabilities', () => {
      const perms = RBAC.getPermissions(Role.OPERATOR)
      expect(perms).toContain('read')
      expect(perms).toContain('write')
      expect(perms).toContain('delete')
      expect(perms).toContain('compact')
      expect(perms).toContain('backup')
      expect(perms).toContain('restore')
      expect(perms).toContain('reshard')
    })
  })

  describe('Error details', () => {
    test('checkPermission should throw AuthError with statusCode 403', () => {
      try {
        RBAC.checkPermission(Role.READER, 'write')
        throw new Error('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(AuthError)
        expect((e as AuthError).statusCode).toBe(403)
        expect((e as AuthError).message).toContain('reader')
        expect((e as AuthError).message).toContain('write')
      }
    })

    test('checkResourceAccess should throw AuthError with statusCode 403', () => {
      try {
        RBAC.checkResourceAccess(Role.READER, 'write:data')
        throw new Error('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(AuthError)
        expect((e as AuthError).statusCode).toBe(403)
      }
    })
  })

  // ──────────────────────────────────────────
  // ACL Tests
  // ──────────────────────────────────────────

  describe('ACL', () => {
    // Ensure clean state before each test
    beforeEach(() => {
      RBAC.clearAcls()
    })

    afterAll(() => {
      RBAC.clearAcls()
    })

    test('addAcl and checkAclPermission works', () => {
      RBAC.addAcl({
        role: Role.READER,
        resource: 'database',
        resourceId: 'db1',
        actions: ['read', 'query'],
      })

      // Should be allowed
      expect(() =>
        RBAC.checkAclPermission(Role.READER, 'read', 'database', 'db1'),
      ).not.toThrow()
      expect(() =>
        RBAC.checkAclPermission(Role.READER, 'query', 'database', 'db1'),
      ).not.toThrow()
    })

    test('checkAclPermission returns false for unauthorized action', () => {
      RBAC.addAcl({
        role: Role.READER,
        resource: 'database',
        resourceId: 'db1',
        actions: ['read'],
      })

      // Should NOT be allowed — 'write' not in ACL
      expect(() =>
        RBAC.checkAclPermission(Role.READER, 'write', 'database', 'db1'),
      ).toThrow(AuthError)
    })

    test('removeAcl removes rules', () => {
      RBAC.addAcl({
        role: Role.READER,
        resource: 'graph_node',
        resourceId: 'node42',
        actions: ['read'],
      })

      // Should be allowed before removal
      expect(() =>
        RBAC.checkAclPermission(Role.READER, 'read', 'graph_node', 'node42'),
      ).not.toThrow()

      // Remove the ACL
      const removed = RBAC.removeAcl(Role.READER, 'graph_node', 'node42')
      expect(removed).toBe(true)

      // After removal, ACLs for this role/resource are gone
      expect(RBAC.getAcls(Role.READER)).toHaveLength(0)
    })

    test('no ACL defined falls back to role-based defaults', () => {
      // No ACLs defined — should use role-based defaults
      expect(() =>
        RBAC.checkAclPermission(Role.READER, 'read'),
      ).not.toThrow()

      expect(() =>
        RBAC.checkAclPermission(Role.READER, 'write'),
      ).toThrow(AuthError)

      expect(() =>
        RBAC.checkAclPermission(Role.WRITER, 'write'),
      ).not.toThrow()

      expect(() =>
        RBAC.checkAclPermission(Role.WRITER, 'compact'),
      ).toThrow(AuthError)
    })

    test('admin role bypasses ACL checks', () => {
      // Even without any ACLs defined, admin can do anything
      expect(() =>
        RBAC.checkAclPermission(Role.ADMIN, 'delete', 'database', 'any-db'),
      ).not.toThrow()
      expect(() =>
        RBAC.checkAclPermission(Role.ADMIN, 'admin', 'any-resource'),
      ).not.toThrow()
    })

    test('aclAllows returns boolean without throwing', () => {
      RBAC.addAcl({
        role: Role.READER,
        resource: 'graph_node',
        actions: ['read'],
      })

      expect(RBAC.aclAllows(Role.READER, 'read', 'graph_node')).toBe(true)
      expect(RBAC.aclAllows(Role.READER, 'delete', 'graph_node')).toBe(false)
    })

    test('getAcls returns entries filtered by role', () => {
      RBAC.addAcl({ role: Role.READER, resource: 'database', actions: ['read'] })
      RBAC.addAcl({ role: Role.WRITER, resource: 'graph_node', actions: ['read', 'write'] })

      const readerAcls = RBAC.getAcls(Role.READER)
      expect(readerAcls).toHaveLength(1)
      expect(readerAcls[0].role).toBe(Role.READER)

      const allAcls = RBAC.getAcls()
      expect(allAcls).toHaveLength(2)
    })

    test('AclMiddleware returns 403 for unauthorized request', () => {
      RBAC.addAcl({
        role: Role.READER,
        resource: 'database',
        resourceId: 'readonly-db',
        actions: ['read'],
      })

      // Authorized action
      expect(() =>
        RBAC.checkAclPermission(Role.READER, 'read', 'database', 'readonly-db'),
      ).not.toThrow()

      // Unauthorized action
      try {
        RBAC.checkAclPermission(Role.READER, 'delete', 'database', 'readonly-db')
        throw new Error('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(AuthError)
        expect((e as AuthError).statusCode).toBe(403)
        expect((e as AuthError).message).toContain('delete')
      }
    })

    test('resourceId wildcard works in ACLs', () => {
      RBAC.addAcl({
        role: Role.READER,
        resource: 'database',
        actions: ['read'],
      })

      // ResourceType match with no resourceId constraint — should work
      expect(() =>
        RBAC.checkAclPermission(Role.READER, 'read', 'database', 'any-db'),
      ).not.toThrow()

      // Wrong resource type — should fail
      expect(() =>
        RBAC.checkAclPermission(Role.READER, 'read', 'graph_node'),
      ).toThrow(AuthError)
    })

    test('admin action in ACL grants all actions on resource', () => {
      RBAC.addAcl({
        role: 'custom_role',
        resource: 'graph_edge',
        resourceId: 'edge1',
        actions: ['admin'],
      })

      expect(() =>
        RBAC.checkAclPermission('custom_role' as Role, 'read', 'graph_edge', 'edge1'),
      ).not.toThrow()
      expect(() =>
        RBAC.checkAclPermission('custom_role' as Role, 'delete', 'graph_edge', 'edge1'),
      ).not.toThrow()
      expect(() =>
        RBAC.checkAclPermission('custom_role' as Role, 'create', 'graph_edge', 'edge1'),
      ).not.toThrow()
    })
  })
})
