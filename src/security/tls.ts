// ============================================================
// TLS — mTLS 配置管理
//
// 提供 TLS 服务器选项和证书 CN 提取。
// 生产环境应使用真实 CA 签名证书，开发环境可使用自签名证书。
// ============================================================

import * as fs from 'fs'
import * as https from 'https'
import { AuthConfig } from '../types'

/**
 * TLS 配置管理
 */
export class TLSConfig {
  private config: AuthConfig

  constructor(config: AuthConfig) {
    if (config.mode !== 'mtls') {
      throw new Error('TLS: only mTLS mode is supported')
    }
    if (!config.tlsCert || !config.tlsKey) {
      throw new Error('TLS: cert and key must be configured for server mode')
    }
    this.config = config
  }

  /**
   * 获取 HTTPS 服务器选项
   * 从文件路径加载证书
   */
  getServerOptions(): https.ServerOptions {
    const cert = fs.readFileSync(this.config.tlsCert!, 'utf-8')
    const key = fs.readFileSync(this.config.tlsKey!, 'utf-8')
    const opts: https.ServerOptions = {
      cert,
      key,
      requestCert: true,
      rejectUnauthorized: true,
    }
    if (this.config.tlsCA) {
      opts.ca = fs.readFileSync(this.config.tlsCA, 'utf-8')
    }
    return opts
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
