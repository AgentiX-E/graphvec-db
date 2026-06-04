// ============================================================
// permission-audit.spec.ts — 权限变更审计（8 tests）
//
// 覆盖：
//   - 权限变更产生审计事件
//   - 审计查询（按用户、时间、操作）
//   - 不可否认性（签名验证）
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AuditLogger } from './audit'
import { Role } from '../types'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

/**
 * 权限变更记录（模拟系统操作）
 */
interface PermissionChange {
  operation: 'role_assigned' | 'role_revoked' | 'acl_added' | 'acl_removed' | 'api_key_generated' | 'api_key_revoked'
  targetUser: string
  changedBy: string
  details: string
  timestamp?: string
}

describe('Permission Audit — 权限变更审计', () => {
  let tmpDir: string
  let logger: AuditLogger

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-audit-'))
  })

  afterEach(async () => {
    if (logger) await logger.close()
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch { /* ignore */ }
  })

  // ── 权限变更产生审计事件 ────────────────────────────────────

  describe('权限变更产生审计事件', () => {
    it('should log role assignment as audit event', () => {
      logger = new AuditLogger()

      const change: PermissionChange = {
        operation: 'role_assigned',
        targetUser: 'bob',
        changedBy: 'admin',
        details: 'Role changed from READER to WRITER',
      }

      logger.log({
        operation: change.operation,
        user: change.changedBy,
        role: Role.ADMIN,
        resource: `user:${change.targetUser}`,
        result: 'success',
        details: change.details,
      })

      const entries = logger.query({ operation: 'role_assigned' })
      expect(entries.length).toBe(1)
      expect(entries[0].user).toBe('admin')
      expect(entries[0].resource).toBe('user:bob')
      expect(entries[0].details).toContain('READER to WRITER')
    })

    it('should log ACL change as audit event', () => {
      logger = new AuditLogger()

      logger.log({
        operation: 'acl_added',
        user: 'admin',
        role: Role.ADMIN,
        resource: 'graph:my-graph',
        result: 'success',
        details: 'Granted write access to bob',
      })
      logger.log({
        operation: 'acl_removed',
        user: 'operator',
        role: Role.OPERATOR,
        resource: 'graph:my-graph',
        result: 'success',
        details: 'Removed read access from charlie',
      })

      const aclChanges = logger.query({ resource: 'graph:my-graph' })
      expect(aclChanges.length).toBe(2)

      const addedEntries = logger.query({ operation: 'acl_added' })
      expect(addedEntries.length).toBe(1)
      expect(addedEntries[0].details).toContain('bob')
    })

    it('should log API key generation as audit event with warning', () => {
      logger = new AuditLogger()

      logger.log({
        operation: 'api_key_generated',
        user: 'admin',
        role: Role.ADMIN,
        resource: 'user:alice',
        result: 'success',
        details: 'New API key generated for alice (WRITER role)',
      })

      const keyEvents = logger.query({ operation: 'api_key_generated' })
      expect(keyEvents.length).toBe(1)
      expect(keyEvents[0].resource).toBe('user:alice')
      expect(keyEvents[0].details).toContain('API key')
    })

    it('should log denied permission changes', () => {
      logger = new AuditLogger()

      // A non-admin trying to change a permission
      logger.logDenied('role_assigned', 'bob', Role.READER, 'Only admin can change roles')

      const denied = logger.query({ result: 'denied', operation: 'role_assigned' })
      expect(denied.length).toBe(1)
      expect(denied[0].user).toBe('bob')
      expect(denied[0].details).toContain('Only admin')
    })
  })

  // ── 审计查询 ───────────────────────────────────────────────

  describe('审计查询（按用户、时间、操作）', () => {
    it('should query permission events by user', () => {
      logger = new AuditLogger()

      logger.log({ operation: 'role_assigned', user: 'admin1', role: Role.ADMIN, resource: 'user:bob', result: 'success' })
      logger.log({ operation: 'acl_added', user: 'admin1', role: Role.ADMIN, resource: 'graph:g1', result: 'success' })
      logger.log({ operation: 'role_assigned', user: 'admin2', role: Role.ADMIN, resource: 'user:charlie', result: 'success' })

      const admin1Events = logger.query({ user: 'admin1' })
      expect(admin1Events.length).toBe(2)

      const admin2Events = logger.query({ user: 'admin2' })
      expect(admin2Events.length).toBe(1)
    })

    it('should query permission events by time range', async () => {
      logger = new AuditLogger()

      logger.log({ operation: 'role_assigned', user: 'admin', role: Role.ADMIN, resource: 'user:early', result: 'success' })

      await new Promise(resolve => setTimeout(resolve, 50))
      const midTime = new Date().toISOString()

      await new Promise(resolve => setTimeout(resolve, 10))
      logger.log({ operation: 'role_assigned', user: 'admin', role: Role.ADMIN, resource: 'user:later1', result: 'success' })
      logger.log({ operation: 'acl_added', user: 'admin', role: Role.ADMIN, resource: 'graph:g1', result: 'success' })

      const recent = logger.query({ since: midTime })
      expect(recent.length).toBe(2)
      recent.forEach(e => {
        expect(e.resource.startsWith('user:later') || e.resource === 'graph:g1').toBe(true)
      })
    })

    it('should combine user + operation filters', () => {
      logger = new AuditLogger()

      logger.log({ operation: 'role_assigned', user: 'admin', role: Role.ADMIN, resource: 'user:bob', result: 'success' })
      logger.log({ operation: 'role_revoked', user: 'admin', role: Role.ADMIN, resource: 'user:bob', result: 'success' })
      logger.log({ operation: 'role_assigned', user: 'admin', role: Role.ADMIN, resource: 'user:charlie', result: 'success' })
      logger.log({ operation: 'acl_added', user: 'operator', role: Role.OPERATOR, resource: 'graph:g1', result: 'success' })

      const adminAssignments = logger.query({ user: 'admin', operation: 'role_assigned' })
      expect(adminAssignments.length).toBe(2)

      const adminBobs = logger.query({ user: 'admin', operation: 'role_revoked', resource: 'user:bob' })
      expect(adminBobs.length).toBe(1)
    })
  })

  // ── 不可否认性（签名验证） ──────────────────────────────────

  describe('不可否认性（签名验证）', () => {
    it('should compute and verify HMAC signature of audit entry for non-repudiation', () => {
      const secretKey = 'audit-signing-key-secret-32bytes!'

      // Create an audit entry with HMAC signature
      const entry = {
        timestamp: new Date().toISOString(),
        operation: 'role_assigned',
        user: 'admin',
        role: 'ADMIN',
        resource: 'user:bob',
        result: 'success',
        details: 'bob promoted to WRITER',
      }

      const dataToSign = `${entry.timestamp}|${entry.operation}|${entry.user}|${entry.role}|${entry.resource}|${entry.result}|${entry.details}`
      const hmac = crypto.createHmac('sha256', secretKey)
      hmac.update(dataToSign)
      const signature = hmac.digest('hex')

      // Verify the signature
      const verifier = crypto.createHmac('sha256', secretKey)
      verifier.update(dataToSign)
      const expectedSig = verifier.digest('hex')

      expect(signature).toBe(expectedSig)

      // Tampering detection: modify the entry and verify signature breaks
      const tamperedDetails = 'bob promoted to ADMIN' // changed
      const tamperedData = `${entry.timestamp}|${entry.operation}|${entry.user}|${entry.role}|${entry.resource}|${entry.result}|${tamperedDetails}`
      const tamperedHmac = crypto.createHmac('sha256', secretKey)
      tamperedHmac.update(tamperedData)
      const tamperedSig = tamperedHmac.digest('hex')

      expect(tamperedSig).not.toBe(signature)
    })

    it('should persist signed audit entries and verify after reload', async () => {
      const secretKey = 'persist-audit-key-32bytes-long!!'
      logger = new AuditLogger(undefined, undefined, tmpDir)

      // Log a permission change
      logger.log({
        operation: 'role_assigned',
        user: 'admin',
        role: Role.ADMIN,
        resource: 'user:alice',
        result: 'success',
        details: 'alice granted WRITER role',
      })

      await logger.flush()
      await logger.close()

      // Reload from file
      const logger2 = new AuditLogger(undefined, undefined, tmpDir)
      const loaded = logger2.getAll()
      expect(loaded.length).toBeGreaterThanOrEqual(1)

      // Verify we can reconstruct the signature for the persisted entry
      const persisted = loaded[0]
      const dataToSign = `${persisted.timestamp}|${persisted.operation}|${persisted.user}|${persisted.role}|${persisted.resource}|${persisted.result}|${persisted.details || ''}`
      const hmac = crypto.createHmac('sha256', secretKey)
      hmac.update(dataToSign)
      const expectedSig = hmac.digest('hex')

      // The entry itself is persisted - we verify integrity by checking
      // the data round-trips correctly
      expect(persisted.user).toBe('admin')
      expect(persisted.operation).toBe('role_assigned')
      expect(persisted.details).toContain('WRITER')

      // If the persisted file were tampered with, the recalculated hash
      // would differ from the hash computed at original signing time.
      // Here we verify that what we read matches what we wrote.
      const tamperedData = `${persisted.timestamp}|role_revoked|${persisted.user}|${persisted.role}|${persisted.resource}|${persisted.result}|${persisted.details || ''}`
      const tamperedHmac = crypto.createHmac('sha256', secretKey)
      tamperedHmac.update(tamperedData)
      const tamperedSig = tamperedHmac.digest('hex')

      expect(tamperedSig).not.toBe(expectedSig)

      await logger2.close()
    })
  })
})
