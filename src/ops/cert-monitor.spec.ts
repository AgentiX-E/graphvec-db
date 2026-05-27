// ============================================================
// CertMonitor — 单元测试
//
// 测试覆盖：
//   - 自签名证书过期检测
//   - 监控器启动/停止
//   - 过期证书场景
//   - Warning / Critical 回调
// ============================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execSync } from 'node:child_process'
import { CertMonitor, CertMonitorConfig } from './cert-monitor'

/** 生成一个有效期指定天数的自签名证书，返回证书文件路径 */
function generateCert(daysValid: number, certDir: string): string {
  const keyPath = path.join(certDir, 'test-key.pem')
  const csrPath = path.join(certDir, 'test-csr.pem')
  const certPath = path.join(certDir, 'test-cert.pem')

  const subj = '/C=CN/ST=Test/L=Test/O=AgentiX/OU=Test/CN=test.agentix.local'

  // 两步法生成自签名证书：
  // 1) openssl req -new -newkey rsa:2048 生成 CSR
  // 2) openssl x509 -req -signkey 自签名
  // 两步法支持负的 -days 值（过期证书），而 openssl req -x509 中 OpenSSL 3.x 不支持
  execSync(
    `openssl req -new -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${csrPath}" -subj "${subj}" 2>/dev/null`,
    { stdio: 'pipe' },
  )
  execSync(
    `openssl x509 -req -in "${csrPath}" -signkey "${keyPath}" -out "${certPath}" -days ${daysValid} 2>/dev/null`,
    { stdio: 'pipe' },
  )

  return certPath
}

describe('CertMonitor', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-monitor-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('_parseCert', () => {
    it('should parse a valid self-signed certificate and extract subject/issuer', () => {
      const certPath = generateCert(365, tmpDir)
      const monitor = new CertMonitor({ certPath })

      // 通过 checkNow 间接验证 _parseCert
      const result = monitor.checkNow()
      expect(result.isValid).toBe(true)
      expect(result.daysUntilExpiry).toBeGreaterThan(0)
      expect(result.subject).toContain('CN=test.agentix.local')
      expect(result.issuer).toContain('CN=test.agentix.local')
    })

    it('should return null for invalid cert path', () => {
      const monitor = new CertMonitor({ certPath: '/nonexistent/cert.pem' })
      const result = monitor.checkNow()
      expect(result.isValid).toBe(false)
      expect(result.daysUntilExpiry).toBe(0)
    })

    it('should return null for invalid PEM content', () => {
      const badPath = path.join(tmpDir, 'bad.pem')
      fs.writeFileSync(badPath, 'not-a-valid-certificate')

      const monitor = new CertMonitor({ certPath: badPath })
      const result = monitor.checkNow()
      expect(result.isValid).toBe(false)
      expect(result.daysUntilExpiry).toBe(0)
    })
  })

  describe('expiry detection', () => {
    it('should detect an already-expired certificate', () => {
      // 生成一个已经过期的证书（-1 天）
      const certPath = generateCert(-1, tmpDir)
      const monitor = new CertMonitor({ certPath })

      const result = monitor.checkNow()
      expect(result.isValid).toBe(false)
      expect(result.daysUntilExpiry).toBeLessThanOrEqual(0)
    })

    it('should trigger onExpired callback for expired cert', () => {
      const certPath = generateCert(-1, tmpDir)
      const onExpired = vi.fn()

      const monitor = new CertMonitor({ certPath, onExpired })
      monitor.checkNow()

      expect(onExpired).toHaveBeenCalledTimes(1)
    })
  })

  describe('warning ranges', () => {
    it('should trigger onCritical when within critical days', () => {
      // 生成有效期很短但尚未过期的证书（临界值避免时机问题）
      const certPath = generateCert(3, tmpDir) // 3 天有效期
      const onCritical = vi.fn()
      const onWarning = vi.fn()
      const onExpired = vi.fn()

      const monitor = new CertMonitor({
        certPath,
        warnDays: 30,
        criticalDays: 7,
        onCritical,
        onWarning,
        onExpired,
      })

      const result = monitor.checkNow()
      // 3 天有效期应 ≤ criticalDays(7)
      expect(result.isValid).toBe(true)
      expect(result.daysUntilExpiry).toBeLessThanOrEqual(7)
      expect(onCritical).toHaveBeenCalledTimes(1)
      expect(onWarning).not.toHaveBeenCalled()
      expect(onExpired).not.toHaveBeenCalled()
    })

    it('should trigger onWarning when within warning days but outside critical', () => {
      // 生成 15 天有效期的证书
      const certPath = generateCert(15, tmpDir)
      const onCritical = vi.fn()
      const onWarning = vi.fn()
      const onExpired = vi.fn()

      const monitor = new CertMonitor({
        certPath,
        warnDays: 30,
        criticalDays: 7,
        onCritical,
        onWarning,
        onExpired,
      })

      const result = monitor.checkNow()
      expect(result.isValid).toBe(true)
      expect(result.daysUntilExpiry).toBeGreaterThan(7)
      expect(result.daysUntilExpiry).toBeLessThanOrEqual(30)
      expect(onWarning).toHaveBeenCalledTimes(1)
      expect(onCritical).not.toHaveBeenCalled()
      expect(onExpired).not.toHaveBeenCalled()
    })

    it('should not trigger any callback for a long-lived cert', () => {
      const certPath = generateCert(365, tmpDir)
      const onCritical = vi.fn()
      const onWarning = vi.fn()
      const onExpired = vi.fn()

      const monitor = new CertMonitor({
        certPath,
        warnDays: 30,
        criticalDays: 7,
        onCritical,
        onWarning,
        onExpired,
      })

      const result = monitor.checkNow()
      expect(result.isValid).toBe(true)
      expect(result.daysUntilExpiry).toBeGreaterThan(30)
      expect(onWarning).not.toHaveBeenCalled()
      expect(onCritical).not.toHaveBeenCalled()
      expect(onExpired).not.toHaveBeenCalled()
    })
  })

  describe('start / stop', () => {
    it('should start interval and return immediately when already started', () => {
      const certPath = generateCert(365, tmpDir)
      const monitor = new CertMonitor({ certPath })

      monitor.start()
      expect((monitor as any).interval).not.toBeNull()

      // idempotent: second start does nothing
      const ref = (monitor as any).interval
      monitor.start()
      expect((monitor as any).interval).toBe(ref)

      monitor.stop()
    })

    it('should stop and clear the interval', () => {
      const certPath = generateCert(365, tmpDir)
      const monitor = new CertMonitor({ certPath })

      monitor.start()
      expect((monitor as any).interval).not.toBeNull()

      monitor.stop()
      expect((monitor as any).interval).toBeNull()
    })

    it('should be idempotent — multiple stop calls do nothing', () => {
      const certPath = generateCert(365, tmpDir)
      const monitor = new CertMonitor({ certPath })

      monitor.start()
      monitor.stop()
      monitor.stop() // should not throw
      expect((monitor as any).interval).toBeNull()
    })
  })
})
