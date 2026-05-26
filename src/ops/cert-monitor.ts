// ============================================================
// CertMonitor — TLS 证书过期预警监控器
//
// 周期性检查 PEM 格式证书的过期时间，在证书即将过期时
// 触发 onWarning / onCritical / onExpired 回调通知。
// 依赖 Node 15.6+ 的 crypto.X509Certificate API。
// ============================================================

import * as fs from 'node:fs'
import * as crypto from 'node:crypto'
import { Logger } from './logger'

export interface CertMonitorConfig {
  /** 证书文件路径（PEM 格式） */
  certPath: string
  /** 检查间隔，默认 1 小时 */
  checkIntervalMs?: number
  /** 在过期前多少天预警，默认 30 天 */
  warnDays?: number
  /** 在过期前多少天报 critical，默认 7 天 */
  criticalDays?: number
  /** 日志实例 */
  logger?: Logger
  /** 证书处于 Warning 范围内时触发 */
  onWarning?: (daysUntilExpiry: number) => void
  /** 证书处于 Critical 范围内时触发 */
  onCritical?: (daysUntilExpiry: number) => void
  /** 证书已过期时触发 */
  onExpired?: () => void
}

const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000 // 1 小时
const DEFAULT_WARN_DAYS = 30
const DEFAULT_CRITICAL_DAYS = 7

export class CertMonitor {
  private interval: ReturnType<typeof setInterval> | null = null
  private config: Required<CertMonitorConfig>

  constructor(config: CertMonitorConfig) {
    this.config = {
      certPath: config.certPath,
      checkIntervalMs: config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
      warnDays: config.warnDays ?? DEFAULT_WARN_DAYS,
      criticalDays: config.criticalDays ?? DEFAULT_CRITICAL_DAYS,
      logger: config.logger ?? new Logger('cert-monitor'),
      onWarning: config.onWarning ?? (() => {}),
      onCritical: config.onCritical ?? (() => {}),
      onExpired: config.onExpired ?? (() => {}),
    }
  }

  /** 启动周期性检查 */
  start(): void {
    if (this.interval !== null) return // 已经启动，跳过

    this.config.logger.info('CertMonitor started', {
      intervalMs: this.config.checkIntervalMs,
      warnDays: this.config.warnDays,
      criticalDays: this.config.criticalDays,
    })

    this.interval = setInterval(() => {
      this.checkNow()
    }, this.config.checkIntervalMs)
  }

  /** 停止周期性检查 */
  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval)
      this.interval = null
      this.config.logger.info('CertMonitor stopped')
    }
  }

  /**
   * 立即执行一次证书过期检查
   *
   * @returns 包含证书有效状态、剩余天数、颁发者和主题信息的对象
   */
  checkNow(): { isValid: boolean; daysUntilExpiry: number; issuer?: string; subject?: string } {
    const parsed = this._parseCert()

    if (parsed === null) {
      this.config.logger.error('Failed to parse certificate', new Error('parse error'), {
        certPath: this.config.certPath,
      })
      return { isValid: false, daysUntilExpiry: 0 }
    }

    const now = new Date()
    const diffMs = parsed.notAfter.getTime() - now.getTime()
    const daysUntilExpiry = Math.ceil(diffMs / (1000 * 60 * 60 * 24))

    const result: { isValid: boolean; daysUntilExpiry: number; issuer?: string; subject?: string } = {
      isValid: diffMs > 0,
      daysUntilExpiry,
      issuer: parsed.issuer,
      subject: parsed.subject,
    }

    if (diffMs <= 0) {
      this.config.logger.error('Certificate has expired', undefined, {
        subject: parsed.subject,
        expiredAt: parsed.notAfter.toISOString(),
      })
      this.config.onExpired()
      result.isValid = false
    } else if (daysUntilExpiry <= this.config.criticalDays) {
      this.config.logger.warn('Certificate is in CRITICAL state — expiring soon', {
        daysUntilExpiry,
        subject: parsed.subject,
        notAfter: parsed.notAfter.toISOString(),
      })
      this.config.onCritical(daysUntilExpiry)
    } else if (daysUntilExpiry <= this.config.warnDays) {
      this.config.logger.warn('Certificate is approaching expiry', {
        daysUntilExpiry,
        subject: parsed.subject,
        notAfter: parsed.notAfter.toISOString(),
      })
      this.config.onWarning(daysUntilExpiry)
    } else {
      this.config.logger.info('Certificate is valid', {
        daysUntilExpiry,
        subject: parsed.subject,
        notAfter: parsed.notAfter.toISOString(),
      })
    }

    return result
  }

  /**
   * 解析 PEM 证书，提取 notAfter、issuer、subject
   * 使用 Node 15.6+ 的 crypto.X509Certificate API
   */
  private _parseCert(): { notAfter: Date; issuer: string; subject: string } | null {
    try {
      const pem = fs.readFileSync(this.config.certPath, 'utf-8')
      const x509 = new crypto.X509Certificate(pem)

      return {
        notAfter: new Date(x509.validTo),
        issuer: x509.issuer,
        subject: x509.subject,
      }
    } catch (err) {
      this.config.logger.error('Failed to parse certificate file', err instanceof Error ? err : new Error(String(err)), {
        certPath: this.config.certPath,
      })
      return null
    }
  }
}
