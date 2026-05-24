import jwt from 'jsonwebtoken'
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto'
import { AuthConfig, AuthResult, Role, AuthError } from '../types'

// ──────────────────────────────────────────
// 密码哈希工具
// ──────────────────────────────────────────

const SCRYPT_KEYLEN = 64
const SCRYPT_COST = 16384
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLEL = 1
const SALT_LENGTH = 32

function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(SALT_LENGTH).toString('hex')
    scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLEL }, (err, key) => {
      if (err) reject(err)
      else resolve(`${salt}:${key.toString('hex')}`)
    })
  })
}

async function verifyPassword(password: string, hashed: string): Promise<boolean> {
  const [salt, keyHex] = hashed.split(':')
  if (!salt || !keyHex) return false
  return new Promise((resolve) => {
    scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLEL }, (err, key) => {
      if (err) resolve(false)
      else {
        try {
          resolve(timingSafeEqual(key, Buffer.from(keyHex, 'hex')))
        } catch {
          resolve(false)
        }
      }
    })
  })
}

/** 
 * 更新所有 storagePath 的 RaftCluster 测试 */

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

// ──────────────────────────────────────────
// UserRegistry — 简单的用户注册/认证系统（用于测试）
// ──────────────────────────────────────────

export class UserRegistry {
  private users: Map<string, { passwordHash: string; role: string; disabled: boolean }> = new Map()

  async register(username: string, password: string, role: string): Promise<void> {
    const passwordHash = await hashPassword(password)
    this.users.set(username, { passwordHash, role, disabled: false })
  }

  async authenticate(username: string, password: string): Promise<boolean> {
    const user = this.users.get(username)
    if (!user || user.disabled) return false
    return verifyPassword(password, user.passwordHash)
  }

  getRole(username: string): string | null {
    const user = this.users.get(username)
    return user ? user.role : null
  }

  disable(username: string): boolean {
    const user = this.users.get(username)
    if (!user) return false
    user.disabled = true
    return true
  }

  changeRole(username: string, newRole: string): boolean {
    const user = this.users.get(username)
    if (!user) return false
    user.role = newRole
    return true
  }

  unregister(username: string): boolean {
    return this.users.delete(username)
  }
}

// ──────────────────────────────────────────
// RateLimiter — 简单的速率限制器（用于测试）
// ──────────────────────────────────────────

export class RateLimiter {
  private allowed: Set<string> = new Set()
  private tokens: Map<string, number> = new Map()
  private maxTokens: number = 10

  allow(key: string): void {
    this.allowed.add(key)
    this.tokens.set(key, this.maxTokens)
  }

  isAllowed(key: string): boolean {
    if (!this.allowed.has(key) && !this.tokens.has(key)) return true // default allow
    const tokens = this.tokens.get(key)
    if (tokens === undefined) return true
    if (tokens > 0) {
      this.tokens.set(key, tokens - 1)
      return true
    }
    return false
  }

  setMaxTokens(max: number): void {
    this.maxTokens = max
  }

  reset(): void {
    this.allowed.clear()
    this.tokens.clear()
  }
}

// ──────────────────────────────────────────
// 认证辅助函数
// ──────────────────────────────────────────

/**
 * Basic Auth 认证（返回 token 字符串）
 */
export async function authenticateBasic(
  registry: UserRegistry,
  username: string,
  password: string,
): Promise<string> {
  const ok = await registry.authenticate(username, password)
  if (!ok) {
    throw new Error('Invalid credentials')
  }
  const role = registry.getRole(username)
  return `basic-token-${username}-${role}`
}

/**
 * 验证 Bearer token
 */
export async function authenticateToken(authHeader: string): Promise<{ user: string; role: string } | null> {
  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    throw new Error('Invalid authorization header')
  }
  const token = parts[1]
  // JWT token — 使用 Authenticator 验证
  try {
    const secret = process.env.AUTH_JWT_SECRET
    if (!secret) return null // 未配置 JWT secret 时拒绝所有请求
    const decoded = jwt.verify(token, secret) as any
    return {
      user: decoded.sub || decoded.user || 'unknown',
      role: decoded.role || 'reader',
    }
  } catch {
    // JWT 验证失败 — 拒绝，不降级到 basic-token
    throw new Error('Invalid token')
  }
}

/**
 * 中间件：需要认证
 */
export function requireAuth(header: string | undefined): void {
  if (!header) {
    throw new Error('Authorization header required')
  }
  try {
    authenticateToken(header)
  } catch {
    throw new Error('Invalid or expired token')
  }
}
