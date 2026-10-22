
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AuditLogger } from './audit'
import { Role } from '../types'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('C-13: Audit Log Rotation & Filtering', () => {
  let tmpDir: string
  let logger: AuditLogger

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-rotate-test-'))
  })

  afterEach(async () => {
    if (logger) await logger.close()
    // Cleanup
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch { /* ignore */ }
  })

  // TC1: 文件轮转
  it('file rotation with rotating-file-stream', async () => {
    logger = new AuditLogger(undefined, undefined, tmpDir)

    // Write several entries
    for (let i = 0; i < 10; i++) {
      logger.log({
        operation: `op-${i}`,
        user: 'test-user',
        role: Role.ADMIN,
        resource: `res-${i}`,
        result: 'success',
      })
    }

    await logger.flush()

    // Wait a bit for any async I/O to complete
    await new Promise(resolve => setTimeout(resolve, 500))

    // Check that log files exist in the directory (rotating-file-stream names them with dates)
    const files = fs.readdirSync(tmpDir)
    const logFiles = files.filter(f => f.startsWith('audit-log'))
    expect(logFiles.length).toBeGreaterThanOrEqual(1)

    // Check content in log files
    let lineCount = 0
    for (const f of logFiles) {
      const fullPath = path.join(tmpDir, f)
      if (fs.statSync(fullPath).isFile()) {
        const content = fs.readFileSync(fullPath, 'utf-8')
        lineCount += content.trim().split('\n').filter(Boolean).length
      }
    }
    expect(lineCount).toBeGreaterThanOrEqual(10)
  })

  // TC2: 按用户过滤
  it('query by user', () => {
    logger = new AuditLogger()

    logger.log({ operation: 'read', user: 'alice', role: Role.READER, resource: 'db1', result: 'success' })
    logger.log({ operation: 'write', user: 'bob', role: Role.WRITER, resource: 'db1', result: 'success' })
    logger.log({ operation: 'read', user: 'alice', role: Role.READER, resource: 'db2', result: 'success' })
    logger.log({ operation: 'delete', user: 'charlie', role: Role.ADMIN, resource: 'db1', result: 'denied' })

    const aliceEntries = logger.query({ user: 'alice' })
    expect(aliceEntries.length).toBe(2)
    aliceEntries.forEach(e => expect(e.user).toBe('alice'))

    const bobEntries = logger.query({ user: 'bob' })
    expect(bobEntries.length).toBe(1)
  })

  // TC3: 按操作过滤
  it('query by operation', () => {
    logger = new AuditLogger()
    logger.log({ operation: 'read', user: 'u1', role: Role.READER, resource: 'r1', result: 'success' })
    logger.log({ operation: 'write', user: 'u2', role: Role.WRITER, resource: 'r1', result: 'success' })
    logger.log({ operation: 'delete', user: 'u3', role: Role.ADMIN, resource: 'r1', result: 'denied' })
    logger.log({ operation: 'compact', user: 'u4', role: Role.OPERATOR, resource: 'r1', result: 'success' })

    const reads = logger.query({ operation: 'read' })
    expect(reads.length).toBe(1)

    const writes = logger.query({ operation: 'write' })
    expect(writes.length).toBe(1)
  })

  // TC4: 按结果过滤
  it('query by result', () => {
    logger = new AuditLogger()
    logger.log({ operation: 'read', user: 'u1', role: Role.READER, resource: 'r1', result: 'success' })
    logger.log({ operation: 'write', user: 'u2', role: Role.WRITER, resource: 'r1', result: 'denied' })
    logger.log({ operation: 'read', user: 'u1', role: Role.READER, resource: 'r2', result: 'success' })

    const denied = logger.query({ result: 'denied' })
    expect(denied.length).toBe(1)

    const allowed = logger.query({ result: 'success' })
    expect(allowed.length).toBe(2)
  })

  // TC5: 按时间范围过滤
  it('query by time range', async () => {
    logger = new AuditLogger()

    // Log with explicit time control
    logger.log({ operation: 'early', user: 'u1', role: Role.ADMIN, resource: 'r1', result: 'success' })

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 50))

    const midTime = new Date().toISOString()

    // Log a couple more
    await new Promise(resolve => setTimeout(resolve, 10))
    logger.log({ operation: 'mid1', user: 'u1', role: Role.ADMIN, resource: 'r1', result: 'success' })
    logger.log({ operation: 'mid2', user: 'u1', role: Role.ADMIN, resource: 'r1', result: 'success' })

    // Query with since filter
    const sinceEntries = logger.query({ since: midTime })
    expect(sinceEntries.length).toBe(2)
    sinceEntries.forEach(e => {
      expect(e.operation.startsWith('mid')).toBe(true)
    })
  })

  // TC6: 组合过滤
  it('combined filters', () => {
    logger = new AuditLogger()
    logger.log({ operation: 'read', user: 'alice', role: Role.READER, resource: 'db1', result: 'success' })
    logger.log({ operation: 'write', user: 'alice', role: Role.WRITER, resource: 'db1', result: 'denied' })
    logger.log({ operation: 'read', user: 'bob', role: Role.READER, resource: 'db1', result: 'success' })
    logger.log({ operation: 'write', user: 'bob', role: Role.WRITER, resource: 'db1', result: 'success' })

    // alice's read operations
    const aliceReads = logger.query({ user: 'alice', operation: 'read' })
    expect(aliceReads.length).toBe(1)
    expect(aliceReads[0].result).toBe('success')

    // denied operations
    const deniedWrites = logger.query({ result: 'denied', operation: 'write' })
    expect(deniedWrites.length).toBe(1)
  })

  // TC7: limit 限制
  it('query with limit', () => {
    logger = new AuditLogger()
    for (let i = 0; i < 20; i++) {
      logger.log({ operation: `op-${i}`, user: 'u1', role: Role.ADMIN, resource: 'r1', result: 'success' })
    }

    const limited = logger.query({ limit: 5 })
    expect(limited.length).toBe(5)

    const unlimited = logger.query({})
    expect(unlimited.length).toBe(20)
  })

  // TC8: 空结果过滤
  it('query returns empty for non-matching filters', () => {
    logger = new AuditLogger()
    logger.log({ operation: 'read', user: 'alice', role: Role.READER, resource: 'db1', result: 'success' })

    const result = logger.query({ user: 'nonexistent' })
    expect(result.length).toBe(0)

    const result2 = logger.query({ result: 'denied' })
    expect(result2.length).toBe(0)
  })
})
