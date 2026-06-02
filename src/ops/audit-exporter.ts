// ============================================================
// AuditLogExporter — 结构化审计日志导出
//
// 从 AuditLog 或 AuditLogger 读取日志条目，
// 支持导出为 JSONL / JSON Array / CSV 格式，
// 支持按时间范围、操作类型、用户过滤。
// ============================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { AuditEntry } from '../types'
import { AuditLog } from './audit-log'
import { AuditLogger } from '../security/audit'

// ── 类型定义 ──────────────────────────────────────────────

export type ExportFormat = 'jsonl' | 'json-array' | 'csv'

export interface ExportFilter {
  startTime?: Date | number
  endTime?: Date | number
  operations?: string[]
  users?: string[]
  results?: Array<'success' | 'denied' | 'error'>
}

export interface ExportResult {
  count: number
  bytes: number
  path: string
  format: ExportFormat
}

export interface ExportMeta {
  exportedAt: string
  format: ExportFormat
  filter?: ExportFilter
  count: number
}

// ── AuditLogExporter ───────────────────────────────────────

export class AuditLogExporter {
  private source: AuditLog | AuditLogger

  constructor(source: AuditLog | AuditLogger) {
    this.source = source
  }

  /**
   * 从 source 获取审计条目（适配两种类型）
   */
  private _getEntries(): AuditEntry[] {
    if (this.source instanceof AuditLog) {
      // AuditLog 有 query 方法但没有 getAll
      const all = this.source.query()
      return all as AuditEntry[]
    } else {
      // AuditLogger 有 getAll 方法
      return (this.source as AuditLogger).getAll()
    }
  }

  /**
   * 应用过滤条件
   */
  private _applyFilter(entries: AuditEntry[], filter?: ExportFilter): AuditEntry[] {
    if (!filter) return entries

    let result = entries

    if (filter.startTime) {
      const t = filter.startTime instanceof Date ? filter.startTime.getTime() : filter.startTime
      result = result.filter(e => new Date(e.timestamp).getTime() >= t)
    }
    if (filter.endTime) {
      const t = filter.endTime instanceof Date ? filter.endTime.getTime() : filter.endTime
      result = result.filter(e => new Date(e.timestamp).getTime() <= t)
    }
    if (filter.operations && filter.operations.length > 0) {
      const ops = new Set(filter.operations)
      result = result.filter(e => ops.has(e.operation))
    }
    if (filter.users && filter.users.length > 0) {
      const us = new Set(filter.users)
      result = result.filter(e => us.has(e.user))
    }
    if (filter.results && filter.results.length > 0) {
      const rs = new Set(filter.results)
      result = result.filter(e => rs.has(e.result))
    }

    return result
  }

  /**
   * 序列化为 JSONL 格式
   */
  private _toJsonl(entries: AuditEntry[]): string {
    return entries.map(e => JSON.stringify(e)).join('\n') + '\n'
  }

  /**
   * 序列化为 JSON Array 格式
   */
  private _toJsonArray(entries: AuditEntry[], meta: ExportMeta): string {
    return JSON.stringify({ meta, entries }, null, 2)
  }

  /**
   * 序列化为 CSV 格式
   */
  private _toCsv(entries: AuditEntry[]): string {
    const header = 'timestamp,operation,user,role,resource,result,latencyMs,details'
    const rows = entries.map(e => {
      const escape = (v: unknown): string => {
        const s = String(v ?? '')
        if (s.includes(',') || s.includes('"') || s.includes('\n')) {
          return '"' + s.replace(/"/g, '""') + '"'
        }
        return s
      }
      return [
        escape(e.timestamp),
        escape(e.operation),
        escape(e.user),
        escape(e.role),
        escape(e.resource),
        escape(e.result),
        escape(e.latencyMs ?? ''),
        escape(e.details ?? ''),
      ].join(',')
    })
    return header + '\n' + rows.join('\n') + '\n'
  }

  /**
   * 导出审计日志
   *
   * @param targetPath 输出文件路径
   * @param format 导出格式
   * @param filter 过滤条件（可选）
   * @returns 导出结果
   */
  async export(
    targetPath: string,
    format: ExportFormat,
    filter?: ExportFilter,
  ): Promise<ExportResult> {
    const all = this._getEntries()
    const filtered = this._applyFilter(all, filter)

    const meta: ExportMeta = {
      exportedAt: new Date().toISOString(),
      format,
      filter,
      count: filtered.length,
    }

    let content: string
    if (format === 'jsonl') {
      content = this._toJsonl(filtered)
    } else if (format === 'json-array') {
      content = this._toJsonArray(filtered, meta)
    } else {
      content = this._toCsv(filtered)
    }

    const dir = path.dirname(targetPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(targetPath, content, 'utf-8')

    const stat = fs.statSync(targetPath)

    return {
      count: filtered.length,
      bytes: stat.size,
      path: targetPath,
      format,
    }
  }

  /**
   * 定时导出任务（使用 setInterval，不引入 cron 依赖）
   *
   * @param intervalMs 间隔毫秒
   * @param format 导出格式
   * @param targetDir 输出目录
   * @param filter 过滤条件（可选）
   * @returns 定时器句柄（可调用 clearInterval 停止）
   */
  scheduleExport(
    intervalMs: number,
    format: ExportFormat,
    targetDir: string,
    filter?: ExportFilter,
  ): ReturnType<typeof setInterval> {
    const run = () => {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const ext = format === 'jsonl' ? 'jsonl' : format === 'json-array' ? 'json' : 'csv'
      const filePath = path.join(targetDir, `audit-export-${timestamp}.${ext}`)
      this.export(filePath, format, filter).catch(() => {})
    }

    fs.mkdirSync(targetDir, { recursive: true })
    return setInterval(run, intervalMs)
  }
}
