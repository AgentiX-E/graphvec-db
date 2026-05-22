import jwt from 'jsonwebtoken'
import { AuthConfig, AuthResult, Role, AuthError } from '../types'

/**
 * Authenticator — 认证入口
 *
 * 支持四种模式：
 * - jwt: JSON Web Token
 * - basic: Basic Auth (username:password)
 * - apikey: API Key 头验证
 * - mtls: 双向 TLS（需配合 tls.ts）
 */
export class Authenticator {
  private config: AuthConfig

  constructor(config: AuthConfig) {
    if (!config.jwtSecret || config.jwtSecret === 'default-secret') {
      throw new Error('AuthConfig.jwtSecret must be set for production use')
    }
    this.config = config
  }

  /**
   * 认证请求
   * @param credentials 认证凭证（token / header / cert）
   * @returns { user: string, role: Role }
   * @throws { AuthError } 认证失败
   */
  async authenticate(credentials: {
    type: 'jwt' | 'basic' | 'apikey' | 'mtls'
    token?: string
    username?: string
    password?: string
    apiKey?: string
    cn?: string
  }): Promise<AuthResult> {
    switch (credentials.type) {
      case 'jwt':
        return this._authenticateJWT(credentials.token)
      case 'basic':
        return this._authenticateBasic(credentials.username, credentials.password)
      case 'apikey':
        return this._authenticateAPIKey(credentials.apiKey)
      case 'mtls':
        return this._authenticateMTLS(credentials.cn)
      default:
        throw new AuthError(`Unsupported auth type: ${credentials.type}`, 400)
    }
  }

  private async _authenticateJWT(token?: string): Promise<AuthResult> {
    if (!token) throw new AuthError('No JWT token provided')
    try {
      const decoded = jwt.verify(token, this.config.jwtSecret!) as any
      return {
        user: decoded.sub || decoded.user || 'unknown',
        role: decoded.role || Role.READER,
      }
    } catch (err) {
      throw new AuthError('Invalid or expired JWT token')
    }
  }

  private async _authenticateBasic(username?: string, password?: string): Promise<AuthResult> {
    if (!username || !password) throw new AuthError('No Basic Auth credentials')
    // Basic Auth 不应该使用 hardcode 凭据
    // 生产环境应查询用户数据库或使用外部身份提供者
    throw new AuthError('Basic Auth requires external identity provider')
  }

  private async _authenticateAPIKey(apiKey?: string): Promise<AuthResult> {
    if (!apiKey) throw new AuthError('No API Key provided')
    const role = this.config.apiKeys?.[apiKey]
    if (role) {
      return { user: `apikey:${apiKey.slice(0, 8)}...`, role }
    }
    throw new AuthError('Invalid API Key')
  }

  private async _authenticateMTLS(cn?: string): Promise<AuthResult> {
    if (!cn) throw new AuthError('No mTLS client certificate')

    // CN 必须是有效的节点 ID（字母数字中划线，1-64 字符）
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(cn)) {
      throw new AuthError('Invalid mTLS certificate CN: must be a valid node ID')
    }

    // 检查节点白名单（如果配置了）
    if (this.config.tlsNodeWhitelist && this.config.tlsNodeWhitelist.length > 0) {
      if (!this.config.tlsNodeWhitelist.includes(cn)) {
        throw new AuthError(`mTLS node ${cn} not in whitelist`)
      }
    }

    return { user: cn, role: Role.READER }
  }
}

/**
 * 验证 AuthConfig 是否满足生产安全要求
 */
export function validateAuthConfig(config: AuthConfig): string[] {
  const errors: string[] = []
  if (!config.jwtSecret || config.jwtSecret === 'default-secret') {
    errors.push('jwtSecret must be set to a secure random string')
  }
  if (!config.apiKeys || Object.keys(config.apiKeys).length === 0) {
    errors.push('at least one apiKey must be configured')
  }
  return errors
}
