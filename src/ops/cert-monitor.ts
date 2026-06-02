// ============================================================
// CertMonitor — TLS 证书过期预警监控器
//
// 周期性检查 PEM 格式证书的过期时间，在证书即将过期时
// 触发 onWarning / onCritical / onExpired 回调通知。
// 依赖 Node 15.6+ 的 crypto.X509Certificate API。
//
// 支持 ACME 自动续期（GAP-23）：
// - 通过 updateConfig() 配置 ACME 参数后调用 autoRenew()
// - 使用 acme-client 执行 Let's Encrypt HTTP-01 验证
// - 续期成功后触发 chokidar 热加载回调
// ============================================================

import * as fs from 'node:fs'
import * as crypto from 'node:crypto'
import * as path from 'node:path'
import { Logger } from './logger'

// 动态导入 acme-client，仅在 autoRenew() 时为 ESM 模块加载
let acmeClient: any = null
async function getAcmeClient(): Promise<any> {
  if (!acmeClient) {
    acmeClient = await import('acme-client')
  }
  return acmeClient
}

export interface CertMonitorConfig {
  /** 证书文件路径（PEM 格式） */
  certPath: string
  /** 私钥文件路径（PEM 格式，用于自动续期） */
  keyPath?: string
  /** 检查间隔，默认 1 小时 */
  checkIntervalMs?: number
  /** 在过期前多少天预警，默认 30 天 */
  warnDays?: number
  /** 在过期前多少天报 critical，默认 7 天 */
  criticalDays?: number
  /** 以天数表示的自动续期阈值（检查到证书过期时间小于此值时自动续期），默认 7 天 */
  renewDays?: number
  /** 日志实例 */
  logger?: Logger
  /** 证书处于 Warning 范围内时触发 */
  onWarning?: (daysUntilExpiry: number) => void
  /** 证书处于 Critical 范围内时触发 */
  onCritical?: (daysUntilExpiry: number) => void
  /** 证书已过期时触发 */
  onExpired?: () => void
  /** 自动续期成功后的回调（例如触发 chokidar 热加载） */
  onRenewed?: () => void
}

// ── ACME 配置（可选，用于 autoRenew） ─────────────────────

export interface AcmeConfig {
  /** Let's Encrypt 邮箱 */
  email: string
  /** 证书域名的私钥文件路径（用于 CSR 签名） */
  domainKeyPath: string
  /** 域名列表 */
  domains: string[]
  /** ACME 目录 URL，默认 Let's Encrypt 生产环境 */
  directoryUrl?: string
  /** 用于 HTTP-01 验证的响应文件输出目录（应由 web server 对外提供） */
  challengePath?: string
  /** 续期后证书文件输出目录（默认与 certPath 同目录） */
  outputDir?: string
}

const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000 // 1 小时
const DEFAULT_WARN_DAYS = 30
const DEFAULT_CRITICAL_DAYS = 7
const DEFAULT_RENEW_DAYS = 7

export class CertMonitor {
  private interval: ReturnType<typeof setInterval> | null = null
  private config: Required<CertMonitorConfig>
  /** ACME 自动续期配置（可选） */
  private acmeConfig: AcmeConfig | null = null
  /** 正在执行自动续期 */
  private _renewing = false

  constructor(config: CertMonitorConfig) {
    this.config = {
      certPath: config.certPath,
      keyPath: config.keyPath ?? '',
      checkIntervalMs: config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
      warnDays: config.warnDays ?? DEFAULT_WARN_DAYS,
      criticalDays: config.criticalDays ?? DEFAULT_CRITICAL_DAYS,
      renewDays: config.renewDays ?? DEFAULT_RENEW_DAYS,
      logger: config.logger ?? new Logger('cert-monitor'),
      onWarning: config.onWarning ?? (() => {}),
      onCritical: config.onCritical ?? (() => {}),
      onExpired: config.onExpired ?? (() => {}),
      onRenewed: config.onRenewed ?? (() => {}),
    }
  }

  /** 配置 ACME 自动续期参数 */
  updateAcmeConfig(acmeConfig: AcmeConfig): void {
    this.acmeConfig = acmeConfig
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

      // 如果配置了 ACME，在 critical 时自动续期
      if (this.acmeConfig && daysUntilExpiry <= this.config.renewDays) {
        this.autoRenew().catch(err => {
          this.config.logger.error('Auto-renewal failed', err instanceof Error ? err : new Error(String(err)))
        })
      }
    } else if (daysUntilExpiry <= this.config.warnDays) {
      this.config.logger.warn('Certificate is approaching expiry', {
        daysUntilExpiry,
        subject: parsed.subject,
        notAfter: parsed.notAfter.toISOString(),
      })
      this.config.onWarning(daysUntilExpiry)

      // 在 warn 阶段如果也进入了 renewDays 范围，自动续期
      if (this.acmeConfig && daysUntilExpiry <= this.config.renewDays) {
        this.autoRenew().catch(err => {
          this.config.logger.error('Auto-renewal failed', err instanceof Error ? err : new Error(String(err)))
        })
      }
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
   * ACME 自动续期
   *
   * 通过 Let's Encrypt 的 HTTP-01 挑战完成证书自动续期。
   * 流程：
   * 1. 创建 ACME 客户端（自动注册账户）
   * 2. 创建订单并完成 HTTP-01 验证
   * 3. 生成 CSR 并获取签名证书
   * 4. 写入 certPath 和 keyPath
   * 5. 触发 onRenewed 回调（用于 chokidar 热加载）
   *
   * @returns 续期成功返回 true，失败抛异常
   */
  async autoRenew(): Promise<boolean> {
    if (!this.acmeConfig) {
      this.config.logger.warn('autoRenew: ACME config not set')
      return false
    }

    // 防止并发续期
    if (this._renewing) {
      this.config.logger.info('autoRenew: already in progress, skipping')
      return false
    }
    this._renewing = true

    try {
      this.config.logger.info('autoRenew: starting ACME certificate renewal', {
        domains: this.acmeConfig.domains,
      })

      const acme = await getAcmeClient()
      const client = new acme.Client({
        directoryUrl: this.acmeConfig.directoryUrl ?? acme.directory.letsencrypt.production,
        accountKey: await acme.crypto.createPrivateKey(),
      })

      // 创建订单
      const [certKey, csr] = await acme.crypto.createCsr({
        key: await acme.crypto.readPrivateKey(this.acmeConfig.domainKeyPath),
        commonName: this.acmeConfig.domains[0],
        altNames: this.acmeConfig.domains,
      })

      const cert = await client.auto({
        csr,
        email: this.acmeConfig.email,
        termOfServiceAgreed: true,
        challengeCreate: async (authz: any, challenge: any, keyAuthorization: string) => {
          // HTTP-01: 将 token 写入 challengePath/.well-known/acme-challenge/{token}
          const challengeDir = this.acmeConfig!.challengePath
            ? path.join(this.acmeConfig!.challengePath!, '.well-known', 'acme-challenge')
            : path.join(path.dirname(this.config.certPath), '.well-known', 'acme-challenge')

          fs.mkdirSync(challengeDir, { recursive: true })
          const tokenPath = path.join(challengeDir, challenge.token)
          fs.writeFileSync(tokenPath, keyAuthorization, 'utf-8')
          this.config.logger.debug(`ACME challenge created: ${tokenPath}`)
        },
        challengeRemove: async (_authz: any, challenge: any, _keyAuthorization: string) => {
          // 清理验证临时文件
          const challengeDir = this.acmeConfig!.challengePath
            ? path.join(this.acmeConfig!.challengePath!, '.well-known', 'acme-challenge')
            : path.join(path.dirname(this.config.certPath), '.well-known', 'acme-challenge')

          const tokenPath = path.join(challengeDir, challenge.token)
          try {
            fs.unlinkSync(tokenPath)
            this.config.logger.debug(`ACME challenge cleaned: ${tokenPath}`)
          } catch {
            // 文件可能已被清理，忽略
          }
        },
      })

      // 保存新证书和私钥
      const certPem = cert.toString()
      const keyPem = await acme.crypto.exportPrivateKey(certKey)

      const outputDir = this.acmeConfig.outputDir ?? path.dirname(this.config.certPath)
      fs.mkdirSync(outputDir, { recursive: true })

      const outputCertPath = this.config.certPath
      const outputKeyPath = this.config.keyPath
        ? this.config.keyPath
        : path.join(outputDir, 'renewed-key.pem')

      // 写原子性：先写临时文件，再 rename
      const tmpCert = outputCertPath + '.renewing'
      const tmpKey = outputKeyPath + '.renewing'
      fs.writeFileSync(tmpCert, certPem, 'utf-8')
      fs.writeFileSync(tmpKey, keyPem, 'utf-8')
      fs.renameSync(tmpCert, outputCertPath)
      fs.renameSync(tmpKey, outputKeyPath)

      this.config.logger.info('autoRenew: certificate renewed successfully', {
        certPath: outputCertPath,
        keyPath: outputKeyPath,
      })

      // 触发续期完成回调（chokidar 热加载触发点）
      this.config.onRenewed()

      return true
    } catch (err) {
      this.config.logger.error('autoRenew: ACME renewal failed', err instanceof Error ? err : new Error(String(err)))
      throw err
    } finally {
      this._renewing = false
    }
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
