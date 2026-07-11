// ============================================================
// TLS — mTLS 配置管理 & TLS 传输层
//
// 提供 TLS 服务器选项和证书 CN 提取。
// 生产环境应使用真实 CA 签名证书，开发环境可使用自签名证书。
//
// 支持证书热加载：通过 chokidar 监视 cert/key/ca 文件变化，
// 自动调用 server.setSecureContext() 更新 TLS 上下文。
//
// 新增功能 (Item 12):
// - generateSelfSignedCert() 生成内存中的自签名证书
// - createTlsServer() 创建 tls.TLSServer
// - createTlsConnection() 创建 tls.TLSSocket 连接
// ============================================================

import * as crypto from 'crypto'
import * as tls from 'tls'
import * as fs from 'fs'
import * as https from 'https'
import * as chokidar from 'chokidar'
import { AuthConfig } from '../types'
import { Logger } from '../ops/logger'

/**
 * TLS 配置管理
 *
 * 负责加载和服务 TLS 证书，并支持运行时热加载。
 * 启动后调用 startCertWatcher() 监视证书文件变更，
 * 变更时通过 server.setSecureContext() 无缝切换证书。
 */
export class TLSConfig {
  private config: AuthConfig

  /** 用于运行时证书热更新的 https.Server 引用 */
  private _tlsServer: https.Server | null = null

  /** chokidar 文件监视器 */
  private _certWatcher: chokidar.FSWatcher | null = null

  /** 证书文件路径缓存 */
  private _certPath: string = ''
  private _keyPath: string = ''
  private _caPath?: string
  private logger: Logger

  constructor(config: AuthConfig) {
    if (config.mode !== 'mtls') {
      throw new Error('TLS: only mTLS mode is supported')
    }
    if (!config.tlsCert || !config.tlsKey) {
      throw new Error('TLS: cert and key must be configured for server mode')
    }
    this.config = config
    this._certPath = config.tlsCert
    this._keyPath = config.tlsKey
    this._caPath = config.tlsCA
    this.logger = new Logger('TLS')
  }

  /**
   * 获取 HTTPS 服务器选项
   * 从文件路径加载证书
   */
  getServerOptions(): https.ServerOptions {
    const cert = fs.readFileSync(this._certPath, 'utf-8')
    const key = fs.readFileSync(this._keyPath, 'utf-8')
    const opts: https.ServerOptions = {
      cert,
      key,
      requestCert: true,
      rejectUnauthorized: true,
    }
    if (this._caPath) {
      opts.ca = fs.readFileSync(this._caPath, 'utf-8')
    }
    return opts
  }

  /**
   * 绑定 https.Server 实例，用于运行时证书热更新
   */
  bindServer(server: https.Server): void {
    this._tlsServer = server
  }

  /**
   * 启动证书文件热加载监视
   *
   * 通过 chokidar 监视 cert/key/ca 文件，文件变更时自动
   * 重新读取并调用 setSecureContext() 更新 TLS 上下文。
   * 支持 awaitWriteFinish，防止部分写入时触发重载。
   *
   * @param certPath 服务端证书路径（Optional，默认使用 config.tlsCert）
   * @param keyPath  服务端私钥路径（Optional，默认使用 config.tlsKey）
   * @param caPath   CA 证书路径（Optional，默认使用 config.tlsCA）
   */
  startCertWatcher(
    certPath?: string,
    keyPath?: string,
    caPath?: string,
  ): void {
    // 如果已启动，先停止旧 watcher
    this.stopCertWatcher()

    // 更新路径（支持覆盖Default value）
    if (certPath) this._certPath = certPath
    if (keyPath) this._keyPath = keyPath
    if (caPath !== undefined) this._caPath = caPath

    const paths: string[] = [this._certPath, this._keyPath]
    if (this._caPath) paths.push(this._caPath)

    this._certWatcher = chokidar.watch(paths, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    })

    this._certWatcher.on('change', () => {
      this._reloadCerts()
    })

    this._certWatcher.on('error', (err) => {
      this.logger.error('Cert watcher error:', err instanceof Error ? err : new Error(String(err)))
    })
  }

  /**
   * 重新加载证书并更新服务器 TLS 上下文
   *
   * 使用 server.setSecureContext() 无缝切换证书，
   * 已有连接不受影响，新连接使用新证书。
   */
  private _reloadCerts(): void {
    try {
      const newCert = fs.readFileSync(this._certPath, 'utf-8')
      const newKey = fs.readFileSync(this._keyPath, 'utf-8')

      if (this._tlsServer) {
        this._tlsServer.setSecureContext({
          cert: newCert,
          key: newKey,
          ca: this._caPath ? fs.readFileSync(this._caPath, 'utf-8') : undefined,
        })
        this.logger.info('Certificates reloaded successfully')
      } else {
        this.logger.warn('No server bound; certificates saved for next bindServer() call')
      }
    } catch (err) {
      // 加载失败不影响运行中的连接
      this.logger.error('Failed to reload certificates:', err instanceof Error ? err : new Error(String(err)))
    }
  }

  /**
   * 停止证书文件监视
   */
  stopCertWatcher(): void {
    if (this._certWatcher) {
      this._certWatcher.close()
      this._certWatcher = null
    }
  }

  /**
   * 获取监视器状态
   */
  isWatching(): boolean {
    return this._certWatcher !== null
  }

  /**
   * 从 HTTP IncomingMessage 提取客户端证书 CN
   *
   * Node.js 的 https server 会将客户端证书存储在 socket 上，
   * 可通过 req.socket.getPeerCertificate() 获取。
   */
  static extractCNFromRequest(req: any): string | null {
    try {
      // Express 和原生 HTTP 请求的 socket 访问路径
      const socket = req.socket || req.connection
      if (!socket || typeof socket.getPeerCertificate !== 'function') return null

      const cert = socket.getPeerCertificate()
      if (!cert || !cert.subject) return null

      return cert.subject.CN || null
    } catch {
      return null
    }
  }
}

// ============================================================
// 自签名证书生成 — 用于开发/测试环境
// ============================================================

export interface SelfSignedCert {
  cert: string
  key: string
  fingerprint: string
  validFrom: Date
  validTo: Date
}

/**
 * 使用 openssl 子进程生成自签名证书
 *
 * 通过 openssl req -x509 命令生成自签名证书和密钥对。
 * 输出到临时文件后读回，然后清理临时文件。
 *
 * @param options 证书选项
 * @returns 包含 cert PEM、key PEM、fingerprint 和有效期的对象
 */
export function generateSelfSignedCert(
  options?: {
    commonName?: string
    validityDays?: number
    keySize?: number
  },
): SelfSignedCert {
  const cn = options?.commonName ?? 'localhost'
  const validityDays = options?.validityDays ?? 365
  const keySize = options?.keySize ?? 2048

  // 使用 child_process 临时跑 openssl
  const cp = require('child_process') as typeof import('child_process')
  const path = require('path') as typeof import('path')
  const os = require('os') as typeof import('os')

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-gen-'))
  const keyPath = path.join(tmpDir, 'key.pem')
  const certPath = path.join(tmpDir, 'cert.pem')

  try {
    const subj = `/CN=${cn}`
    const args = [
      'req', '-x509',
      '-newkey', `rsa:${keySize}`,
      '-keyout', keyPath,
      '-out', certPath,
      '-days', String(validityDays),
      '-subj', subj,
      '-nodes',
      '-sha256',
    ]

    cp.execFileSync('openssl', args, { stdio: 'pipe' })

    const certPem = fs.readFileSync(certPath, 'utf-8')
    const keyPem = fs.readFileSync(keyPath, 'utf-8')

    // 解析证书获取 fingerprint 和有效期
    const cert = new crypto.X509Certificate(certPem)
    const fingerprint = cert.fingerprint
    const validFrom = new Date(cert.validFrom)
    const validTo = new Date(cert.validTo)

    return { cert: certPem, key: keyPem, fingerprint, validFrom, validTo }
  } finally {
    // 清理临时文件
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

// ============================================================
// TLS 连接工厂
// ============================================================

export interface TlsConnectionResult {
  /** 服务器 socket（已连接） */
  socket: tls.TLSSocket
  /** 关闭函数 */
  close: () => void
}

/**
 * 创建自定义 TLS 服务器
 *
 * 使用 node:tls 模块创建低延迟的 TLS 服务器，适合 RPC/消息传递场景。
 * 不依赖 HTTP 协议层，支持原始二进制数据交换。
 *
 * @param options 服务器 TLS 选项（cert, key, ca 等）
 * @param onData 收到数据时的回调（data: Buffer）
 * @param onError Error回调（Optional）
 * @returns TLSServer 实例（需调用 listen() 启动）
 */
export function createTlsServer(
  options: tls.TlsOptions,
  onData: (data: Buffer, socket: tls.TLSSocket) => void,
  onError?: (err: Error, socket?: tls.TLSSocket) => void,
): tls.Server {
  const server = tls.createServer(options, (socket) => {
    // 第一次 data 事件注册
    socket.on('data', (data: Buffer) => {
      onData(data, socket)
    })

    socket.on('error', (err: Error) => {
      if (onError) onError(err, socket)
    })

    // 如果需要端到端确认，发送握手完成标记
    if (!socket.authorized) {
      socket.on('error', () => {
        // 未授权连接的Error已通过 error 事件处理
      })
    }
  })

  return server
}

/**
 * 创建 TLS 客户端连接
 *
 * 连接到指定的 TLS 服务器，返回连接好的 socket。
 * 支持自签名证书场景（通过 checkServerIdentity 开关）。
 *
 * @param host 服务器主机名
 * @param port 服务器端口
 * @param options 连接选项（cert, key, ca, rejectUnauthorized 等）
 * @param rejectUnauthorized 是否验证服务端证书（生产环境应为 true）
 * @returns Promise<TlsConnectionResult>
 */
export function createTlsConnection(
  host: string,
  port: number,
  options: tls.ConnectionOptions,
  rejectUnauthorized: boolean = true,
): Promise<TlsConnectionResult> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(port, host, {
      ...options,
      rejectUnauthorized,
      // 自签名证书开发模式下禁用主机名校验
      checkServerIdentity: rejectUnauthorized
        ? undefined
        : () => undefined,
    })

    // 连接成功（握手完成）
    socket.once('secureConnect', () => {
      resolve({ socket, close: () => socket.destroy() })
    })

    // 连接失败
    socket.once('error', (err: Error) => {
      reject(err)
    })

    // 超时保护：10 秒后如果还没连上，自动取消
    socket.setTimeout(10000, () => {
      socket.destroy()
      reject(new Error(`TLS connection timeout to ${host}:${port}`))
    })
  })
}
