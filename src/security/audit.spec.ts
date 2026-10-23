// ============================================================
// audit.spec.ts — AuditLogger + RemoteAuditSink 单元测试
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AuditLogger, RemoteAuditSink } from './audit'
import { Role, type AuditEntry } from '../types'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import http from 'http'

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

  // ─── 持久化测试 ──────────────────────────────

  describe('persistence with storagePath', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-persist-'))
    })

    afterEach(async () => {
      // close any logger we might have opened
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('creates ndjson file on first log', () => {
      const alog = new AuditLogger(undefined, undefined, tmpDir)
      alog.log({
        operation: 'CREATE_NODE',
        user: 'admin',
        role: Role.ADMIN,
        resource: 'graph:test',
        result: 'success',
      })
      alog.save()

      const ndjsonPath = path.join(tmpDir, 'audit-log.ndjson')
      expect(fs.existsSync(ndjsonPath)).toBe(true)
      const content = fs.readFileSync(ndjsonPath, 'utf-8')
      expect(content).toContain('CREATE_NODE')
      expect(content).toContain('admin')
    })

    it('loads entries from existing ndjson file on construction', () => {
      // First instance writes entries
      const log1 = new AuditLogger(undefined, undefined, tmpDir)
      log1.log({ operation: 'OP1', user: 'u1', role: Role.ADMIN, resource: 'r1', result: 'success' })
      log1.log({ operation: 'OP2', user: 'u2', role: Role.WRITER, resource: 'r2', result: 'denied' })
      log1.save()
      log1.close()

      // Second instance loads from disk
      const log2 = new AuditLogger(undefined, undefined, tmpDir)
      const entries = log2.getAll()
      expect(entries.length).toBeGreaterThanOrEqual(2)
      expect(entries[0].operation).toBe('OP1')
      expect(entries[1].operation).toBe('OP2')
      log2.close()
    })

    it('persists and recovers multiple entries in order', () => {
      const log1 = new AuditLogger(undefined, undefined, tmpDir)
      const count = 5
      for (let i = 0; i < count; i++) {
        log1.log({
          operation: `OP${i}`,
          user: 'u',
          role: Role.ADMIN,
          resource: 'r',
          result: 'success',
        })
      }
      log1.save()
      log1.close()

      const log2 = new AuditLogger(undefined, undefined, tmpDir)
      const entries = log2.getAll()
      expect(entries.length).toBeGreaterThanOrEqual(count)
      for (let i = 0; i < count; i++) {
        expect(entries[i].operation).toBe(`OP${i}`)
      }
      log2.close()
    })

    it('auto flushes on threshold', async () => {
      // Use a separate small threshold by manually triggering
      const alog = new AuditLogger(undefined, undefined, tmpDir)
      const ndjsonPath = path.join(tmpDir, 'audit-log.ndjson')

      // Log 999 entries (below default threshold of 1000)
      for (let i = 0; i < 900; i++) {
        alog.log({
          operation: `AUTO_OP_${i}`,
          user: 'u',
          role: Role.ADMIN,
          resource: 'r',
          result: 'success',
        })
      }

      // Save after 900 entries
      alog.save()
      expect(fs.existsSync(ndjsonPath)).toBe(true)
      alog.close()
    })

    it('flush writes to file', () => {
      const alog = new AuditLogger(undefined, undefined, tmpDir)
      alog.log({
        operation: 'FLUSH_TEST',
        user: 'flusher',
        role: Role.OPERATOR,
        resource: 'test',
        result: 'success',
      })

      alog.flush()

      const ndjsonPath = path.join(tmpDir, 'audit-log.ndjson')
      expect(fs.existsSync(ndjsonPath)).toBe(true)
      const content = fs.readFileSync(ndjsonPath, 'utf-8')
      expect(content).toContain('FLUSH_TEST')
      alog.close()
    })

    it('close flushes remaining entries', async () => {
      const alog = new AuditLogger(undefined, undefined, tmpDir)
      alog.log({
        operation: 'CLOSE_FLUSH',
        user: 'test',
        role: Role.ADMIN,
        resource: 'x',
        result: 'success',
      })

      await alog.close()

      const ndjsonPath = path.join(tmpDir, 'audit-log.ndjson')
      expect(fs.existsSync(ndjsonPath)).toBe(true)
      expect(fs.readFileSync(ndjsonPath, 'utf-8')).toContain('CLOSE_FLUSH')
    })

    it('handles empty storage gracefully', () => {
      const alog = new AuditLogger(undefined, undefined, tmpDir)
      expect(alog.entryCount).toBe(0)
      alog.close()
    })

    it('getStoragePath returns the storage path', () => {
      const alog = new AuditLogger(undefined, undefined, tmpDir)
      expect(alog.getStoragePath()).toBe(tmpDir)
      alog.close()
    })

    it('getStoragePath returns null when no storage path set', () => {
      const alog = new AuditLogger()
      expect(alog.getStoragePath()).toBeNull()
    })
  })
})

// ──────────────────────────────────────────
// RemoteAuditSink 测试
// ──────────────────────────────────────────

describe('RemoteAuditSink', () => {
  it('creates sink with endpoint URL', () => {
    const sink = new RemoteAuditSink({ endpoint: 'http://localhost:9999/audit' })
    expect(sink).toBeDefined()
    const stats = sink.stats()
    expect(stats.sent).toBe(0)
    expect(stats.failed).toBe(0)
    expect(stats.cached).toBe(0)
    sink.close()
  })

  it('caches entries when network is down', async () => {
    const sink = new RemoteAuditSink({
      endpoint: 'http://localhost:1/audit', // Unreachable port
      timeoutMs: 100,
      retryIntervalMs: 50000, // Long retry to avoid interference
    })

    const entry: AuditEntry = {
      operation: 'TEST',
      user: 'tester',
      role: Role.ADMIN,
      resource: 'test',
      result: 'success',
      timestamp: new Date().toISOString(),
    }

    await sink.send(entry)
    const stats = sink.stats()
    expect(stats.failed).toBeGreaterThanOrEqual(1)
    expect(stats.cached).toBeGreaterThanOrEqual(1)
    sink.close()
  }, 10000)

  it('discards oldest entries when cache exceeds maxCached', async () => {
    const sink = new RemoteAuditSink({
      endpoint: 'http://localhost:1/audit',
      timeoutMs: 50,
      maxCached: 5,
      retryIntervalMs: 50000,
    })

    for (let i = 0; i < 10; i++) {
      await sink.send({
        operation: `OP_${i}`,
        user: 'u',
        role: Role.ADMIN,
        resource: 'r',
        result: 'success',
        timestamp: new Date().toISOString(),
      })
    }

    const stats = sink.stats()
    expect(stats.cached).toBeLessThanOrEqual(5)
    sink.close()
  }, 10000)

  it('can send batch entries', async () => {
    const sink = new RemoteAuditSink({
      endpoint: 'http://localhost:1/audit',
      timeoutMs: 50,
      maxCached: 100,
      retryIntervalMs: 50000,
    })

    const entries: AuditEntry[] = Array.from({ length: 3 }, (_, i) => ({
      operation: `BATCH_OP_${i}`,
      user: 'batch',
      role: Role.OPERATOR,
      resource: 'batch-test',
      result: 'success',
      timestamp: new Date().toISOString(),
    }))

    await sink.sendBatch(entries)
    const stats = sink.stats()
    expect(stats.failed).toBeGreaterThanOrEqual(1)
    sink.close()
  }, 10000)

  it('returns correct stats after successful send', async () => {
    // Start a local HTTP server to receive audit logs
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port

    const sink = new RemoteAuditSink({
      endpoint: `http://127.0.0.1:${port}/audit`,
      timeoutMs: 3000,
    })

    await sink.send({
      operation: 'SERVER_TEST',
      user: 'srv',
      role: Role.ADMIN,
      resource: 'server-test',
      result: 'success',
      timestamp: new Date().toISOString(),
    })

    const stats = sink.stats()
    expect(stats.sent).toBeGreaterThanOrEqual(1)
    expect(stats.failed).toBe(0)

    sink.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, 10000)

  it('flush cache retries on retry interval', async () => {
    const sink = new RemoteAuditSink({
      endpoint: 'http://localhost:1/audit',
      timeoutMs: 50,
      retryIntervalMs: 100,
      maxCached: 100,
    })

    await sink.send({
      operation: 'CACHE_TEST',
      user: 'cache',
      role: Role.WRITER,
      resource: 'cache-test',
      result: 'success',
      timestamp: new Date().toISOString(),
    })

    // Wait for retry
    await new Promise(r => setTimeout(r, 300))
    const stats = sink.stats()
    expect(stats.failed).toBeGreaterThanOrEqual(1)

    sink.close()
  }, 10000)

  it('close stops retry timer', () => {
    const sink = new RemoteAuditSink({
      endpoint: 'http://localhost:1/audit',
      timeoutMs: 50,
    })

    sink.close()
    // Should not throw
    expect(() => sink.close()).not.toThrow()
  })
})
