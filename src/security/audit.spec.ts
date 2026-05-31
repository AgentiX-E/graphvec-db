// ============================================================
// audit.spec.ts — AuditLogger 单元测试
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AuditLogger } from './audit'
import { Role } from '../types'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('AuditLogger', () => {
  let logger: AuditLogger

  beforeEach(() => {
    logger = new AuditLogger()
  })

  afterEach(() => {
    logger.clear()
  })

  describe('log', () => {
    it('records a basic audit entry', () => {
      logger.log({
        operation: 'CREATE_NODE',
        user: 'admin',
        role: Role.ADMIN,
        resource: 'graph:users',
        result: 'success',
      })

      const entries = logger.getAll()
      expect(entries).toHaveLength(1)
      expect(entries[0].operation).toBe('CREATE_NODE')
      expect(entries[0].user).toBe('admin')
      expect(entries[0].role).toBe(Role.ADMIN)
      expect(entries[0].result).toBe('success')
    })

    it('adds an ISO timestamp automatically', () => {
      const before = Date.now()
      logger.log({
        operation: 'READ',
        user: 'reader1',
        role: Role.READER,
        resource: 'node:42',
        result: 'success',
      })
      const after = Date.now()

      const entry = logger.getAll()[0]
      expect(entry.timestamp).toBeDefined()
      const ts = new Date(entry.timestamp).getTime()
      expect(ts).toBeGreaterThanOrEqual(before)
      expect(ts).toBeLessThanOrEqual(after + 1000)
    })

    it('accepts optional details and latencyMs', () => {
      logger.log({
        operation: 'QUERY',
        user: 'op1',
        role: Role.OPERATOR,
        resource: 'db:main',
        result: 'success',
        latencyMs: 42,
        details: 'slow query detected',
      })

      const entry = logger.getAll()[0]
      expect(entry.latencyMs).toBe(42)
      expect(entry.details).toBe('slow query detected')
    })

    it('records multiple entries in order', () => {
      logger.log({
        operation: 'OP1',
        user: 'u1',
        role: Role.ADMIN,
        resource: 'r1',
        result: 'success',
      })
      logger.log({
        operation: 'OP2',
        user: 'u2',
        role: Role.WRITER,
        resource: 'r2',
        result: 'denied',
      })
      logger.log({
        operation: 'OP3',
        user: 'u3',
        role: Role.READER,
        resource: 'r3',
        result: 'error',
      })

      expect(logger.getAll()).toHaveLength(3)
      expect(logger.getAll()[0].operation).toBe('OP1')
      expect(logger.getAll()[1].operation).toBe('OP2')
      expect(logger.getAll()[2].operation).toBe('OP3')
    })
  })

  describe('logDenied', () => {
    it('records a denied action with reason', () => {
      logger.logDenied('DELETE_EDGE', 'intruder', Role.READER, 'insufficient permissions')

      const entry = logger.getAll()[0]
      expect(entry.operation).toBe('DELETE_EDGE')
      expect(entry.user).toBe('intruder')
      expect(entry.role).toBe(Role.READER)
      expect(entry.result).toBe('denied')
      expect(entry.details).toBe('insufficient permissions')
    })

    it('records a denied action without reason', () => {
      logger.logDenied('WRITE', 'guest', Role.READER)

      const entry = logger.getAll()[0]
      expect(entry.result).toBe('denied')
      expect(entry.details).toBeUndefined()
    })
  })

  describe('logError', () => {
    it('records an error with message', () => {
      const error = new Error('connection timeout')
      logger.logError('QUERY', 'user1', Role.OPERATOR, error)

      const entry = logger.getAll()[0]
      expect(entry.operation).toBe('QUERY')
      expect(entry.result).toBe('error')
      expect(entry.details).toBe('connection timeout')
    })
  })

  describe('getRecent', () => {
    it('returns the last N entries', () => {
      for (let i = 0; i < 10; i++) {
        logger.log({
          operation: `OP${i}`,
          user: 'u',
          role: Role.ADMIN,
          resource: 'r',
          result: 'success',
        })
      }

      const recent = logger.getRecent(3)
      expect(recent).toHaveLength(3)
      expect(recent[0].operation).toBe('OP7')
      expect(recent[2].operation).toBe('OP9')
    })

    it('returns all entries when count > total', () => {
      for (let i = 0; i < 3; i++) {
        logger.log({
          operation: `OP${i}`,
          user: 'u',
          role: Role.ADMIN,
          resource: 'r',
          result: 'success',
        })
      }

      const recent = logger.getRecent(100)
      expect(recent).toHaveLength(3)
    })

    it('returns default 100 entries', () => {
      for (let i = 0; i < 5; i++) {
        logger.log({
          operation: `OP${i}`,
          user: 'u',
          role: Role.ADMIN,
          resource: 'r',
          result: 'success',
        })
      }

      const recent = logger.getRecent()
      expect(recent).toHaveLength(5)
    })
  })

  describe('getAll', () => {
    it('returns all entries', () => {
      expect(logger.getAll()).toEqual([])

      logger.log({
        operation: 'TEST',
        user: 'u',
        role: Role.ADMIN,
        resource: 'r',
        result: 'success',
      })

      expect(logger.getAll()).toHaveLength(1)
    })

    it('returns a copy (immutable)', () => {
      logger.log({
        operation: 'OP',
        user: 'u',
        role: Role.ADMIN,
        resource: 'r',
        result: 'success',
      })

      const all = logger.getAll()
      all.push({} as any)
      expect(logger.getAll()).toHaveLength(1)
    })
  })

  describe('clear', () => {
    it('clears all in-memory entries', () => {
      logger.log({
        operation: 'TEMP',
        user: 'u',
        role: Role.ADMIN,
        resource: 'r',
        result: 'success',
      })
      expect(logger.getAll()).toHaveLength(1)

      logger.clear()
      expect(logger.getAll()).toEqual([])
    })

    it('is safe to call on empty logger', () => {
      expect(() => logger.clear()).not.toThrow()
    })
  })

  describe('constructor with logPath', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('creates logger with file destination without throwing', () => {
      const logPath = path.join(tmpDir, 'audit.log')
      expect(() => new AuditLogger(undefined, logPath)).not.toThrow()
    })
  })
})
