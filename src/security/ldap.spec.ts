// ============================================================
// ldap.spec.ts — LDAP 认证 + 子图权限 单元测试
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { LdapAuthenticator, RBAC } from './auth'
import { Role, AuthError } from '../types'

describe('LdapAuthenticator', () => {
  let authenticator: LdapAuthenticator

  beforeEach(() => {
    authenticator = new LdapAuthenticator({
      url: 'ldap://localhost:389',
      bindDn: 'cn=admin,dc=example,dc=com',
      bindPassword: 'admin',
      baseDn: 'dc=example,dc=com',
      userFilter: '(uid={{username}})',
      defaultRole: Role.READER,
      allowMock: true, // 测试模式：不连接真实 LDAP
    })
  })

  describe('construction', () => {
    it('should create with valid config', () => {
      expect(authenticator).toBeInstanceOf(LdapAuthenticator)
    })

    it('should return a copy of config', () => {
      const cfg = authenticator.getConfig()
      expect(cfg.url).toBe('ldap://localhost:389')
      expect(cfg.baseDn).toBe('dc=example,dc=com')
      expect(cfg.allowMock).toBe(true)
    })

    it('should reject config modifications via getConfig', () => {
      const cfg = authenticator.getConfig() as any
      // Should not be able to modify original
      expect(() => { cfg.url = 'evil' }).not.toThrow()
      // Original remains unchanged since we return a copy
      expect(authenticator.getConfig().url).toBe('ldap://localhost:389')
    })
  })

  describe('mock authenticate', () => {
    it('should authenticate admin with ADMIN role', async () => {
      const result = await authenticator.authenticate('admin', 'password123')
      expect(result).toEqual({
        user: 'admin',
        role: Role.ADMIN,
      })
    })

    it('should authenticate non-admin user with default READER role', async () => {
      const result = await authenticator.authenticate('alice', 'password123')
      expect(result).toEqual({
        user: 'alice',
        role: Role.READER,
      })
    })

    it('should reject empty username', async () => {
      await expect(
        authenticator.authenticate('', 'password')
      ).rejects.toThrow(AuthError)
    })

    it('should reject empty password', async () => {
      await expect(
        authenticator.authenticate('alice', '')
      ).rejects.toThrow(AuthError)
    })

    it('should reject null username', async () => {
      await expect(
        (authenticator as any).authenticate(null, 'password')
      ).rejects.toThrow()
    })
  })

  describe('subgraph permissions', () => {
    it('should manage subgraph permissions', () => {
      // Add permissions
      authenticator.addSubgraphPermission({
        userId: 'alice',
        subgraph: 'subgraph-project-x',
        actions: ['read', 'write'],
      })

      authenticator.addSubgraphPermission({
        userId: 'bob',
        subgraph: 'subgraph-project-x',
        actions: ['read'],
      })

      // Check permissions
      expect(authenticator.checkSubgraphPermission('alice', 'subgraph-project-x', 'read')).toBe(true)
      expect(authenticator.checkSubgraphPermission('alice', 'subgraph-project-x', 'write')).toBe(true)
      expect(authenticator.checkSubgraphPermission('bob', 'subgraph-project-x', 'read')).toBe(true)
      expect(authenticator.checkSubgraphPermission('bob', 'subgraph-project-x', 'write')).toBe(false)

      // Unauthorized user
      expect(authenticator.checkSubgraphPermission('charlie', 'subgraph-project-x', 'read')).toBe(false)

      // Unknown subgraph
      expect(authenticator.checkSubgraphPermission('alice', 'subgraph-unknown', 'read')).toBe(false)
    })

    it('should support admin action as wildcard', () => {
      authenticator.addSubgraphPermission({
        userId: 'admin-user',
        subgraph: 'subgraph-secret',
        actions: ['admin'],
      })

      expect(authenticator.checkSubgraphPermission('admin-user', 'subgraph-secret', 'read')).toBe(true)
      expect(authenticator.checkSubgraphPermission('admin-user', 'subgraph-secret', 'write')).toBe(true)
      expect(authenticator.checkSubgraphPermission('admin-user', 'subgraph-secret', 'admin')).toBe(true)
    })

    it('should remove subgraph permissions', () => {
      authenticator.addSubgraphPermission({
        userId: 'alice',
        subgraph: 'subgraph-temp',
        actions: ['read', 'write'],
      })

      expect(authenticator.checkSubgraphPermission('alice', 'subgraph-temp', 'read')).toBe(true)

      const removed = authenticator.removeSubgraphPermission('alice', 'subgraph-temp')
      expect(removed).toBe(true)
      expect(authenticator.checkSubgraphPermission('alice', 'subgraph-temp', 'read')).toBe(false)
    })

    it('should return false when removing non-existent permission', () => {
      const removed = authenticator.removeSubgraphPermission('ghost', 'nonexistent')
      expect(removed).toBe(false)
    })

    it('should get all permissions for a user', () => {
      authenticator.addSubgraphPermission({
        userId: 'alice',
        subgraph: 'subgraph-a',
        actions: ['read'],
      })
      authenticator.addSubgraphPermission({
        userId: 'alice',
        subgraph: 'subgraph-b',
        actions: ['read', 'write'],
      })

      const alicePerms = authenticator.getUserSubgraphPermissions('alice')
      expect(alicePerms).toHaveLength(2)

      const bobPerms = authenticator.getUserSubgraphPermissions('bob')
      expect(bobPerms).toHaveLength(0)
    })

    it('should get all subgraph permissions', () => {
      authenticator.addSubgraphPermission({
        userId: 'alice',
        subgraph: 'subgraph-x',
        actions: ['read'],
      })
      authenticator.addSubgraphPermission({
        userId: 'bob',
        subgraph: 'subgraph-y',
        actions: ['write'],
      })

      const all = authenticator.getAllSubgraphPermissions()
      expect(all).toHaveLength(2)
    })

    it('should merge duplicate permission entries by combining actions', () => {
      authenticator.addSubgraphPermission({
        userId: 'alice',
        subgraph: 'subgraph-merge',
        actions: ['read'],
      })
      authenticator.addSubgraphPermission({
        userId: 'alice',
        subgraph: 'subgraph-merge',
        actions: ['write'],
      })

      const perms = authenticator.getUserSubgraphPermissions('alice')
      expect(perms).toHaveLength(1)
      expect(perms[0].actions).toContain('read')
      expect(perms[0].actions).toContain('write')
    })

    it('should clear all permissions', () => {
      authenticator.addSubgraphPermission({
        userId: 'alice',
        subgraph: 'subgraph-x',
        actions: ['read'],
      })
      authenticator.clearSubgraphPermissions()
      expect(authenticator.getAllSubgraphPermissions()).toHaveLength(0)
      expect(authenticator.checkSubgraphPermission('alice', 'subgraph-x', 'read')).toBe(false)
    })
  })

  describe('mock mode with custom default role', () => {
    it('should use custom default role for non-admin users', async () => {
      const customAuth = new LdapAuthenticator({
        url: 'ldap://localhost:389',
        bindDn: 'cn=admin,dc=example,dc=com',
        bindPassword: 'admin',
        baseDn: 'dc=example,dc=com',
        userFilter: '(uid={{username}})',
        defaultRole: Role.WRITER,
        allowMock: true,
      })

      const result = await customAuth.authenticate('bob', 'password')
      expect(result.role).toBe(Role.WRITER)
    })
  })
})

describe('RBAC Subgraph Permissions', () => {
  beforeEach(() => {
    RBAC.clearAcls()
  })

  afterEach(() => {
    RBAC.clearAcls()
  })

  describe('checkSubgraphPermission', () => {
    it('should allow ADMIN access to any subgraph', () => {
      expect(() =>
        RBAC.checkSubgraphPermission(Role.ADMIN, 'any-subgraph', 'read')
      ).not.toThrow()
      expect(() =>
        RBAC.checkSubgraphPermission(Role.ADMIN, 'any-subgraph', 'write')
      ).not.toThrow()
    })

    it('should deny access when no ACL defined for subgraph', () => {
      // READER 默认有 read 权限，但不一定有 write 权限
      expect(() =>
        RBAC.checkSubgraphPermission(Role.READER, 'subgraph-secret', 'read')
      ).not.toThrow()

      expect(() =>
        RBAC.checkSubgraphPermission(Role.READER, 'subgraph-secret', 'write')
      ).toThrow(AuthError)
    })

    it('should grant access with correct ACL', () => {
      RBAC.addAcl({
        role: Role.READER,
        resource: 'subgraph:subgraph-public',
        actions: ['read'],
      })

      expect(() =>
        RBAC.checkSubgraphPermission(Role.READER, 'subgraph-public', 'read')
      ).not.toThrow()
    })

    it('should deny access when action not in ACL', () => {
      RBAC.addAcl({
        role: Role.READER,
        resource: 'subgraph:subgraph-readonly',
        actions: ['read'],
      })

      expect(() =>
        RBAC.checkSubgraphPermission(Role.READER, 'subgraph-readonly', 'write')
      ).toThrow(AuthError)
    })

    it('should grant admin action for wildcard ACL', () => {
      RBAC.addAcl({
        role: Role.OPERATOR,
        resource: 'subgraph:subgraph-ops',
        actions: ['admin'],
      })

      expect(() =>
        RBAC.checkSubgraphPermission(Role.OPERATOR, 'subgraph-ops', 'read')
      ).not.toThrow()
      expect(() =>
        RBAC.checkSubgraphPermission(Role.OPERATOR, 'subgraph-ops', 'write')
      ).not.toThrow()
    })

    it('should allow multiple roles with different permissions on same subgraph', () => {
      RBAC.addAcl({
        role: Role.READER,
        resource: 'subgraph:subgraph-billing',
        actions: ['read'],
      })
      RBAC.addAcl({
        role: Role.WRITER,
        resource: 'subgraph:subgraph-billing',
        actions: ['read', 'write'],
      })

      // READER can only read
      expect(() =>
        RBAC.checkSubgraphPermission(Role.READER, 'subgraph-billing', 'read')
      ).not.toThrow()
      expect(() =>
        RBAC.checkSubgraphPermission(Role.READER, 'subgraph-billing', 'write')
      ).toThrow(AuthError)

      // WRITER can read and write
      expect(() =>
        RBAC.checkSubgraphPermission(Role.WRITER, 'subgraph-billing', 'read')
      ).not.toThrow()
      expect(() =>
        RBAC.checkSubgraphPermission(Role.WRITER, 'subgraph-billing', 'write')
      ).not.toThrow()
    })
  })

  describe('getSubgraphAcls', () => {
    it('should return empty array for subgraph with no ACLs', () => {
      const acls = RBAC.getSubgraphAcls('subgraph-nonexistent')
      expect(acls).toEqual([])
    })

    it('should return correct ACLs for a subgraph', () => {
      RBAC.addAcl({
        role: Role.READER,
        resource: 'subgraph:subgraph-a',
        actions: ['read'],
      })
      RBAC.addAcl({
        role: Role.WRITER,
        resource: 'subgraph:subgraph-a',
        actions: ['read', 'write'],
      })

      const acls = RBAC.getSubgraphAcls('subgraph-a')
      expect(acls).toHaveLength(2)
      expect(acls.some(a => a.role === Role.READER && a.actions.includes('read'))).toBe(true)
      expect(acls.some(a => a.role === Role.WRITER && a.actions.includes('write'))).toBe(true)
    })
  })
})
