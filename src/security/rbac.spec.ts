import { RBAC } from './rbac'
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
        fail('Should have thrown')
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
        fail('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(AuthError)
        expect((e as AuthError).statusCode).toBe(403)
      }
    })
  })
})
