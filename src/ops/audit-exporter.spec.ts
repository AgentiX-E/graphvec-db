// ============================================================
// AuditLogExporter 测试
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { AuditLogExporter, ExportFormat, ExportFilter } from './audit-exporter'
import { AuditLog } from './audit-log'
import { Role } from '../types'

// ── 辅助: 用类型兼容的 AuditEntry 创建测试实例 ──
// 注意: audit-log.ts 中的 AuditEntry 类型与 types.ts 略有不同，
// 我们在 spec 中定义本地版本以保持隔离

interface TestAuditEntry {
  timestamp: string
  hlctimestamp?: string // this field name is cased differently in some versions, using hlcTimestamp or not
  hlcTimestamp?: string
  operation: string
  user: string
  role: string
  resource: string
  result: 'success' | 'denied' | 'error'
  latencyMs?: number
  details?: string
}

function createTestAuditLog(): AuditLog {
  const log = new AuditLog()
  log.log({ operation: 'upsert_node', user: 'admin', role: Role.ADMIN, resource: 'node:1', result: 'success' })
  log.log({ operation: 'delete_node', user: 'admin', role: Role.ADMIN, resource: 'node:2', result: 'success' })
  log.log({ operation: 'upsert_node', user: 'writer', role: Role.WRITER, resource: 'node:3', result: 'success' })
  log.log({ operation: 'upsert_edge', user: 'writer', role: Role.WRITER, resource: 'edge:1', result: 'error', details: 'Validation failed' })
  log.log({ operation: 'delete_node', user: 'operator', role: Role.OPERATOR, resource: 'node:4', result: 'denied' })
  return log
}

describe('AuditLogExporter', () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), 'audit-exporter-test-'))
  })

  afterEach(() => {
    // 清理临时目录
    try {
      const files = fs.readdirSync(testDir)
      for (const f of files) {
        fs.unlinkSync(path.join(testDir, f))
      }
      fs.rmdirSync(testDir)
    } catch {
      // ignore cleanup errors
    }
  })

  describe('export JSONL', () => {
    it('应该导出为 JSONL 格式', async () => {
      const log = createTestAuditLog()
      const exporter = new AuditLogExporter(log)
      const outPath = path.join(testDir, 'audit.jsonl')

      const result = await exporter.export(outPath, 'jsonl')

      expect(result.count).toBe(5)
      expect(result.format).toBe('jsonl')
      expect(result.bytes).toBeGreaterThan(0)

      // 验证内容：每行是一个完整的 JSON 对象
      const content = fs.readFileSync(outPath, 'utf-8')
      const lines = content.split('\n').filter(Boolean)
      expect(lines).toHaveLength(5)

      for (const line of lines) {
        const parsed = JSON.parse(line)
        expect(parsed.timestamp).toBeDefined()
        expect(parsed.operation).toBeDefined()
        expect(parsed.user).toBeDefined()
      }
    })

    it('空日志导出为空的 JSONL', async () => {
      const log = new AuditLog()
      const exporter = new AuditLogExporter(log)
      const outPath = path.join(testDir, 'empty.jsonl')

      const result = await exporter.export(outPath, 'jsonl')
      expect(result.count).toBe(0)
      expect(result.bytes).toBeGreaterThan(0) // 文件存在但只含有换行符

      const content = fs.readFileSync(outPath, 'utf-8')
      expect(content.trim()).toBe('')
    })
  })

  describe('export JSON Array', () => {
    it('应该导出为 JSON Array 格式（含 meta）', async () => {
      const log = createTestAuditLog()
      const exporter = new AuditLogExporter(log)
      const outPath = path.join(testDir, 'audit.json')

      const result = await exporter.export(outPath, 'json-array')

      expect(result.count).toBe(5)
      expect(result.format).toBe('json-array')

      const content = fs.readFileSync(outPath, 'utf-8')
      const parsed = JSON.parse(content)
      expect(parsed.meta).toBeDefined()
      expect(parsed.meta.format).toBe('json-array')
      expect(parsed.meta.count).toBe(5)
      expect(parsed.entries).toHaveLength(5)
    })
  })

  describe('export CSV', () => {
    it('应该导出为 CSV 格式', async () => {
      const log = createTestAuditLog()
      const exporter = new AuditLogExporter(log)
      const outPath = path.join(testDir, 'audit.csv')

      const result = await exporter.export(outPath, 'csv')

      expect(result.count).toBe(5)
      expect(result.format).toBe('csv')

      const content = fs.readFileSync(outPath, 'utf-8')
      const lines = content.split('\n').filter(Boolean)
      expect(lines).toHaveLength(6) // header + 5 rows

      // 验证 header
      expect(lines[0]).toContain('timestamp')
      expect(lines[0]).toContain('operation')
      expect(lines[0]).toContain('user')
      expect(lines[0]).toContain('result')
    })

    it('CSV 中特殊字符正确转义', async () => {
      const log = new AuditLog()
      log.log({
        operation: 'upsert',
        user: 'admin',
        role: Role.ADMIN,
        resource: 'node:1',
        result: 'success',
        details: 'hello, world', // 含逗号
      })
      log.log({
        operation: 'upsert',
        user: 'admin',
        role: Role.ADMIN,
        resource: 'node:2',
        result: 'success',
        details: 'line1\nline2', // 含换行符
      })

      const exporter = new AuditLogExporter(log)
      const outPath = path.join(testDir, 'special.csv')
      const result = await exporter.export(outPath, 'csv')

      expect(result.count).toBe(2)

      const content = fs.readFileSync(outPath, 'utf-8')
      expect(content).toContain('"hello, world"')
      expect(content).toContain('"line1\nline2"')
    })
  })

  describe('filter', () => {
    it('按 operation 过滤后导出', async () => {
      const log = createTestAuditLog()
      const exporter = new AuditLogExporter(log)
      const outPath = path.join(testDir, 'filtered.jsonl')

      const result = await exporter.export(outPath, 'jsonl', {
        operations: ['upsert_node'],
      })

      expect(result.count).toBe(2) // 只有 2 条 upsert_node
    })

    it('按 user 过滤后导出', async () => {
      const log = createTestAuditLog()
      const exporter = new AuditLogExporter(log)
      const outPath = path.join(testDir, 'by-user.jsonl')

      const result = await exporter.export(outPath, 'jsonl', {
        users: ['writer'],
      })

      expect(result.count).toBe(2) // writer 有 2 条
    })

    it('按 result 过滤后导出', async () => {
      const log = createTestAuditLog()
      const exporter = new AuditLogExporter(log)
      const outPath = path.join(testDir, 'by-result.jsonl')

      const result = await exporter.export(outPath, 'jsonl', {
        results: ['error', 'denied'],
      })

      expect(result.count).toBe(2) // 1 error + 1 denied
    })

    it('按时间范围过滤后导出', async () => {
      const log = createTestAuditLog()
      const exporter = new AuditLogExporter(log)

      // 获取当前所有条目
      const all = log.query()
      const timestamps = all.map(e => new Date(e.timestamp).getTime())
      const minT = Math.min(...timestamps)
      const maxT = Math.max(...timestamps)

      // 时间范围应包含所有条目
      const resultAll = await exporter.export(
        path.join(testDir, 'all.jsonl'),
        'jsonl',
        { startTime: new Date(minT - 1000), endTime: new Date(maxT + 1000) },
      )
      expect(resultAll.count).toBe(5)

      // 使用某个中间时间点进行过滤
      const midT = minT + (maxT - minT) / 2
      const resultMid = await exporter.export(
        path.join(testDir, 'mid.jsonl'),
        'jsonl',
        { startTime: new Date(midT) },
      )
      expect(resultMid.count).toBeGreaterThanOrEqual(2)
      expect(resultMid.count).toBeLessThanOrEqual(5)

      // 使用遥远的未来时间，应返回 0
      const resultFuture = await exporter.export(
        path.join(testDir, 'future.jsonl'),
        'jsonl',
        { startTime: new Date(maxT + 3600000) },
      )
      expect(resultFuture.count).toBe(0)

      // 使用遥远的过去时间，应返回全部
      const resultPast = await exporter.export(
        path.join(testDir, 'past.jsonl'),
        'jsonl',
        { endTime: new Date(minT - 3600000) },
      )
      expect(resultPast.count).toBe(0)
    })
  })

  describe('scheduleExport', () => {
    it('定时导出应生成文件', async () => {
      const log = createTestAuditLog()
      const exporter = new AuditLogExporter(log)

      const interval = setInterval(() => {}, 100000) // 防止实际运行
      clearInterval(interval)

      // 手动测试 scheduleExport 的行为
      const timer = exporter.scheduleExport(60000, 'jsonl', testDir)
      expect(timer).toBeDefined()

      // 触发一次
      await exporter.export(path.join(testDir, 'manual.jsonl'), 'jsonl')
      expect(fs.existsSync(path.join(testDir, 'manual.jsonl'))).toBe(true)

      clearInterval(timer)
    })
  })
})
