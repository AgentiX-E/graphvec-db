// ============================================================
// Auth — mTLS 认证引擎 + JWT Token 签发/验证 + API Key 管理
//
// 主认证方式为 mTLS，同时提供：
// - JWT bearer token (HMAC-SHA256) 供 REST API 使用
// - API Key 供自动化/CI 场景使用
// ============================================================

import { RBAC as RbacAcl } from './rbac'
export { AclEntry, AclResourceType, AclAction } from './rbac'

import * as http from 'http'
import { AuthConfig, AuthResult, Role, AuthError } from '../types'
import { Logger } from '../ops/logger'
import * as crypto from 'crypto'

/**
 * mTLS 认证引擎
 *
 * 验证流程：
 * 1. 从客户端证书提取 CN（Common Name）
 * 2. 在授权列表（identities）中查找 CN
 * 3. 找到则返回对应的身份和角色
 * 4. 未找到则使用 defaultRole（如果有配置）
 * 5. 无 defaultRole 则拒绝访问
 */
export class Authenticator {
  private config: AuthConfig
  /** 当前生效的身份配置（内存快照） */
  private identities: Map<string, { role: Role; databases?: string[] }>
  /** 是否已初始化 */
  private _initialized = false
  /** chokidar watcher 实例 */
  private _watcher: { close: () => Promise<void> } | null = null
  private logger: Logger

  constructor(config: AuthConfig) {
    if (config.mode !== 'mtls') {
      throw new Error('Auth: only mTLS mode is supported')
    }
    if (!config.tlsCert || !config.tlsKey) {
      throw new Error('Auth: tlsCert and tlsKey are required for mTLS mode')
    }
    this.config = config
    this.logger = new Logger('Auth')
    this.identities = new Map()
    this._loadIdentities()
  }

  /**
   * 从配置加载身份映射
   */
  private _loadIdentities(): void {
    this.identities.clear()

    // 从 config.identities 加载
    if (this.config.identities) {
      for (const id of this.config.identities) {
        this.identities.set(id.cn, { role: id.role, databases: id.databases })
      }
    }

    // 从 identitiesFile 加载（覆盖 config.identities）
    if (this.config.identitiesFile) {
      try {
        const fs = require('fs')
        const raw = fs.readFileSync(this.config.identitiesFile, 'utf-8')
        const data = JSON.parse(raw)
        if (Array.isArray(data.identities)) {
          for (const id of data.identities) {
            if (id.cn) {
              this.identities.set(id.cn, {
                role: id.role || Role.READER,
                databases: id.databases,
              })
            }
          }
        }
      } catch (err) {
        this.logger.warn(`failed to load identities file "${this.config.identitiesFile}": ${(err as Error).message}`)
      }
    }

    this._initialized = true
  }

  /**
   * 启动身份文件热加载
   * 使用 chokidar 监听文件变更，即时生效
   */
  startWatch(): void {
    if (!this.config.identitiesFile) return
    if (this._watcher) return

    try {
      const chokidar = require('chokidar')
      const watcher = chokidar.watch(this.config.identitiesFile, {
        persistent: false,
        ignoreInitial: false,
        awaitWriteFinish: {
          stabilityThreshold: 200,
          pollInterval: 100,
        },
      })

      watcher.on('change', () => {
        this.logger.info('identities file changed, reloading...')
        this._loadIdentities()
      })

      this._watcher = watcher
    } catch (err) {
      this.logger.warn('chokidar not available, falling back to stat polling')
      this._startStatPolling()
    }
  }

  /**
   * 兜底方案：stat 轮询（仅当 chokidar 加载失败时使用）
   */
  private _watchTimer: ReturnType<typeof setInterval> | null = null

  private _startStatPolling(): void {
    if (!this.config.identitiesFile) return

    const fs = require('fs')
    let lastMtime = 0
    try {
      lastMtime = fs.statSync(this.config.identitiesFile)?.mtimeMs || 0
    } catch { /* 文件还不存在 */ }

    this._watchTimer = setInterval(() => {
      try {
        const stat = fs.statSync(this.config.identitiesFile)
        if (stat.mtimeMs > lastMtime) {
          this.logger.info('identities file changed (poll), reloading...')
          this._loadIdentities()
          lastMtime = stat.mtimeMs
        }
      } catch { /* 文件临时不可读 */ }
    }, 30000)
    this._watchTimer.unref()
  }

  /**
   * 停止文件监控
   */
  stopWatch(): void {
    // 关闭 chokidar watcher
    if (this._watcher) {
      this._watcher.close().catch(() => {})
      this._watcher = null
    }
    // 关闭 stat polling
    if (this._watchTimer) {
      clearInterval(this._watchTimer)
      this._watchTimer = null
    }
  }

  /**
   * 强制重新加载身份配置
   */
  reloadIdentities(): void {
    this._loadIdentities()
    this.logger.info('identities reloaded')
  }

  /**
   * 认证：根据证书 CN 返回用户身份
   *
   * @param cn 客户端证书的 Common Name
   * @returns AuthResult 包含用户标识、角色、数据库白名单
   * @throws AuthError 认证失败
   */
  authenticate(cn: string): AuthResult {
    if (!cn || typeof cn !== 'string') {
      throw new AuthError('mTLS: client certificate CN is required')
    }

    // 1. 查找授权身份
    const identity = this.identities.get(cn)
    if (identity) {
      return {
        user: cn,
        role: identity.role,
        databases: identity.databases,
      }
    }

    // 2. 用 defaultRole 兜底
    if (this.config.defaultRole !== undefined) {
      return {
        user: cn,
        role: this.config.defaultRole,
        databases: this.config.defaultDatabases,
      }
    }

    // 3. 拒绝
    throw new AuthError(`mTLS: certificate CN "${cn}" is not authorized`)
  }

  /**
   * 是否已有身份配置
   */
  get initialized(): boolean {
    return this._initialized
  }

  /**
   * 获取当前所有已授权的 CN 列表
   */
  listAuthorizedCNs(): string[] {
    return [...this.identities.keys()]
  }
}

// ──────────────────────────────────────────
// RBAC — 基于角色的访问控制
// ──────────────────────────────────────────

export class RBAC {
  private static readonly PERMISSIONS: Record<Role, Set<string>> = {
    [Role.ADMIN]: new Set(['*']),
    [Role.OPERATOR]: new Set([
      'read', 'write', 'delete',
      'compact', 'backup', 'restore', 'reshard',
      'health', 'metrics', 'audit',
    ]),
    [Role.WRITER]: new Set(['read', 'write', 'delete']),
    [Role.READER]: new Set(['read']),
  }

  /**
   * 检查角色是否有权限执行操作
   * @throws { AuthError } 无权限，statusCode=403
   */
  static checkPermission(role: Role, operation: string): void {
    if (role === Role.ADMIN) return

    const allowed = RBAC.PERMISSIONS[role]
    if (!allowed || !allowed.has(operation)) {
      throw new AuthError(
        `Role '${role}' does not have permission for '${operation}'`,
        403,
      )
    }
  }

  /**
   * 检查用户是否有权访问指定数据库
   */
  static checkDatabaseAccess(role: Role, databases: string[] | undefined, database: string): void {
    if (role === Role.ADMIN) return
    if (!databases || databases.length === 0) return // 未限定 = 全部可访问
    if (databases.includes(database)) return
    throw new AuthError(
      `Access denied to database '${database}'`,
      403,
    )
  }

  /**
   * 检查资源访问权限
   */
  static checkResourceAccess(role: Role, resourceType: string): void {
    // admin 可以访问任何资源
    if (role === Role.ADMIN) return

    // reader 只能读
    if (role === Role.READER && resourceType.startsWith('write:')) {
      throw new AuthError('Reader cannot write resources', 403)
    }
  }

  /** 获取角色的所有权限 */
  static getPermissions(role: Role): string[] {
    if (role === Role.ADMIN) return ['* (all)']
    return [...(RBAC.PERMISSIONS[role] || [])]
  }

  // ──────────────────────────────────────────
  // ACL 方法（委托给 rbac.ts 的完整实现）
  // ──────────────────────────────────────────

  /**
   * ACL-aware permission check.
   * Checks ACLs first; falls back to role-based defaults if no ACLs defined.
   * @throws { AuthError } if not authorized (statusCode=403)
   */
  static checkAclPermission(
    role: Role,
    action: string,
    resource?: string,
    resourceId?: string,
  ): void {
    return RbacAcl.checkAclPermission(role, action, resource, resourceId)
  }

  /** Add an ACL entry */
  static addAcl(entry: { role: string; resource: string; resourceId?: string; actions: string[] }): void {
    return RbacAcl.addAcl(entry)
  }

  /** Remove ACL entries matching the given criteria */
  static removeAcl(role: string, resource: string, resourceId?: string): boolean {
    return RbacAcl.removeAcl(role, resource, resourceId)
  }

  /** Check if ACL allows the action (boolean, doesn't throw) */
  static aclAllows(role: string, action: string, resource?: string, resourceId?: string): boolean {
    return RbacAcl.aclAllows(role, action, resource, resourceId)
  }

  /** Get ACL entries, optionally filtered by role */
  static getAcls(role?: string): { role: string; resource: string; resourceId?: string; actions: string[] }[] {
    return RbacAcl.getAcls(role)
  }

  /** Clear all ACLs (useful for testing) */
  static clearAcls(): void {
    return RbacAcl.clearAcls()
  }
}

/**
 * 验证 AuthConfig 是否满足生产安全要求
 */
export function validateAuthConfig(config: AuthConfig): string[] {
  const errors: string[] = []
  if (config.mode !== 'mtls') {
    errors.push('auth mode must be "mtls"')
  }
  if (!config.tlsCert) {
    errors.push('tlsCert must be configured')
  }
  if (!config.tlsKey) {
    errors.push('tlsKey must be configured')
  }
  if (!config.identities || config.identities.length === 0) {
    if (!config.identitiesFile) {
      if (config.defaultRole === undefined) {
        errors.push('at least one identity, identitiesFile, or defaultRole must be configured')
      }
    }
  }
  return errors
}

// ──────────────────────────────────────────
// 兼容导出（旧接口）
// ──────────────────────────────────────────

/** @deprecated 不再支持 UserRegistry，使用 mTLS + 身份文件 */
export class UserRegistry {
  async register(): Promise<void> {
    throw new Error('UserRegistry is deprecated. Use mTLS authentication with identities config instead.')
  }
  async authenticate(): Promise<boolean> {
    throw new Error('UserRegistry is deprecated. Use mTLS authentication with identities config instead.')
  }
  getRole(): string | null {
    throw new Error('UserRegistry is deprecated.')
  }
  disable(): boolean {
    throw new Error('UserRegistry is deprecated.')
  }
  changeRole(): boolean {
    throw new Error('UserRegistry is deprecated.')
  }
  unregister(): boolean {
    throw new Error('UserRegistry is deprecated.')
  }
}

// ──────────────────────────────────────────
// Body Size Limit — 请求体大小限制中间件
// ──────────────────────────────────────────

/** 默认最大请求体大小：10MB */
export const BODY_SIZE_LIMIT = 10485760

/** 默认读取超时：30 秒 */
export const BODY_READ_TIMEOUT = 30000

/**
 * Body Size Limit 中间件工厂
 *
 * 对 POST/PUT/PATCH 请求检查请求体大小：
 * - 有 Content-Length 且超过 maxSize → 返回 413
 * - 无 Content-Length → 流式读取，累计超过 maxSize 后断开
 * - 读取超时 → 断开连接
 *
 * @param maxSize 最大字节数（默认 10MB）
 * @param readTimeout 读取超时毫秒数（默认 30s，0=不超时）
 */
export function bodySizeLimitMiddleware(
  maxSize: number = BODY_SIZE_LIMIT,
  readTimeout: number = BODY_READ_TIMEOUT,
) {
  return function bodySizeLimitHandler(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    next: () => void,
  ): void {
    // 只限制 POST/PUT/PATCH
    const method = req.method?.toUpperCase() ?? 'GET'
    if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
      next()
      return
    }

    // bodySizeLimit = 0 → 拒绝所有请求体
    if (maxSize <= 0) {
      jsonSizeResponse(res, 413, { error: 'Request body size limit is set to 0, rejecting all body payloads' })
      return
    }

    // 检查 Content-Length header
    const contentLengthStr = req.headers['content-length']
    if (contentLengthStr) {
      const contentLength = parseInt(contentLengthStr, 10)
      if (!isNaN(contentLength) && contentLength > maxSize) {
        jsonSizeResponse(res, 413, { error: 'Request body too large' })
        return
      }
      // 有 Content-Length 且在限制内 → 放行
      next()
      return
    }

    // 没有 Content-Length → 流式读取检查
    let totalBytes = 0
    let aborted = false
    let timedOut = false

    // 设置读取超时
    let readTimer: ReturnType<typeof setTimeout> | undefined
    if (readTimeout > 0) {
      readTimer = setTimeout(() => {
        timedOut = true
        aborted = true
        req.destroy(new Error('Request body read timeout'))
        if (!res.headersSent) {
          jsonSizeResponse(res, 413, { error: 'Request body read timeout' })
        }
      }, readTimeout)
    }

    const onData = (chunk: Buffer) => {
      if (aborted) return
      totalBytes += chunk.length
      if (totalBytes > maxSize && !timedOut) {
        aborted = true
        req.destroy(new Error('Request body exceeded limit'))
        if (readTimer) clearTimeout(readTimer)
        if (!res.headersSent) {
          jsonSizeResponse(res, 413, { error: 'Request body exceeded limit' })
        }
      }
    }

    const onEnd = () => {
      if (readTimer) clearTimeout(readTimer)
      if (!aborted) {
        req.removeListener('data', onData)
        req.removeListener('end', onEnd)
        req.removeListener('error', onError)
        next()
      }
    }

    const onError = (err: Error) => {
      if (readTimer) clearTimeout(readTimer)
      aborted = true
      if (!res.headersSent) {
        jsonSizeResponse(res, 413, { error: err.message || 'Request body read error' })
      }
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    // 设置编码以确保 chunk 是 Buffer
    req.setEncoding('utf8')
  }
}

/**
 * 发送 JSON 响应并同时设置 Content-Length 以防 413 被 Node.js 吞掉
 */
function jsonSizeResponse(
  res: http.ServerResponse,
  statusCode: number,
  data: unknown,
): void {
  const body = JSON.stringify(data)
  if (!res.headersSent) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Connection': 'close',
    })
  }
  res.end(body)
}

/** @deprecated */
export class RateLimiter {}

/**
 * JWT 载荷接口
 */
export interface JwtPayload {
  userId: string
  role: Role
  exp: number   // expiration timestamp (seconds since epoch)
  iat?: number  // issued at
}

/**
 * API Key 记录
 */
export interface ApiKeyRecord {
  key: string          // 完整 API Key (仅创建时返回)
  keyPrefix: string    // 前 8 位用于识别
  userId: string
  role: Role
  createdAt: number
  enabled: boolean
}

/**
 * JWT Manager — HMAC-SHA256 签发/验证
 *
 * 使用 Node.js 内置 crypto 模块实现 HMAC-SHA256 签名。
 * Token 格式: base64url(header).base64url(payload).base64url(signature)
 * 符合 JWT 标准 (RFC 7519)。
 */
export class JwtManager {
  private secret: Buffer
  private readonly ISSUER = 'agentiX-graphvec'
  private readonly ALGORITHM = 'HS256'

  /**
   * @param secret 签名密钥（至少 32 字节）
   */
  constructor(secret?: string | Buffer) {
    if (secret) {
      this.secret = typeof secret === 'string' ? Buffer.from(secret) : secret
    } else {
      // 默认生成 256-bit 密钥
      this.secret = crypto.randomBytes(32)
    }
    if (this.secret.length < 16) {
      throw new Error('JWT secret must be at least 16 bytes')
    }
  }

  /**
   * 签发 JWT token
   *
   * @param userId  用户标识
   * @param role    用户角色
   * @param expiresInSec 过期时间（秒），默认 3600 (1h)
   * @returns 签名的 JWT token 字符串
   */
  signToken(userId: string, role: Role, expiresInSec: number = 3600): string {
    const header = { alg: this.ALGORITHM, typ: 'JWT' }
    const now = Math.floor(Date.now() / 1000)
    const payload: JwtPayload = {
      userId,
      role,
      exp: now + expiresInSec,
      iat: now,
    }

    const headerB64 = this._base64urlEncode(Buffer.from(JSON.stringify(header)))
    const payloadB64 = this._base64urlEncode(Buffer.from(JSON.stringify(payload)))
    const signature = this._sign(`${headerB64}.${payloadB64}`)

    return `${headerB64}.${payloadB64}.${signature}`
  }

  /**
   * 验证并解码 JWT token
   *
   * @param token JWT token 字符串
   * @returns 解码后的 JwtPayload
   * @throws AuthError 如果 token 无效或已过期
   */
  verifyToken(token: string): JwtPayload {
    const parts = token.split('.')
    if (parts.length !== 3) {
      throw new AuthError('Invalid JWT token format', 401)
    }

    const [headerB64, payloadB64, signatureB64] = parts

    // 验证签名
    const expectedSig = this._sign(`${headerB64}.${payloadB64}`)
    const sigBuf = Buffer.from(signatureB64)
    const expectedBuf = Buffer.from(expectedSig)
    if (sigBuf.length !== expectedBuf.length ||
        !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      throw new AuthError('Invalid JWT signature', 401)
    }

    // 解码 payload
    let payload: JwtPayload
    try {
      const decoded = JSON.parse(this._base64urlDecode(payloadB64).toString('utf-8'))
      payload = {
        userId: decoded.userId,
        role: decoded.role as Role,
        exp: decoded.exp,
        iat: decoded.iat,
      }
    } catch {
      throw new AuthError('Invalid JWT payload', 401)
    }

    // 检查过期
    const now = Math.floor(Date.now() / 1000)
    if (payload.exp <= now) {
      throw new AuthError('JWT token has expired', 401)
    }

    return payload
  }

  /**
   * 从 HTTP Authorization header 提取并验证 bearer token
   */
  authenticateFromHeader(authHeader: string | undefined): JwtPayload {
    if (!authHeader) {
      throw new AuthError('Authorization header is required', 401)
    }

    const parts = authHeader.split(' ')
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      throw new AuthError('Authorization header must use Bearer scheme', 401)
    }

    return this.verifyToken(parts[1])
  }

  // ── 内部方法 ──────────────────────────────

  private _sign(data: string): string {
    const hmac = crypto.createHmac('sha256', this.secret)
    hmac.update(data)
    return this._base64urlEncode(hmac.digest())
  }

  private _base64urlEncode(buf: Buffer): string {
    return buf.toString('base64url')
  }

  private _base64urlDecode(str: string): Buffer {
    return Buffer.from(str, 'base64url')
  }
}

/**
 * API Key 管理器
 *
 * 生成固定格式的 API Key:
 *   agx_<random 32 bytes base64url>
 * 并存储 key 的哈希用于验证。
 *
 * API Key 是不可逆的（只存储 SHA-256 哈希），
 * 因此创建后只返回一次完整 key。
 */
export class ApiKeyManager {
  private keys: Map<string, { userId: string; role: Role; createdAt: number; enabled: boolean }> = new Map()
  private prefixIndex: Map<string, string> = new Map() // keyPrefix → keyHash

  /**
   * 生成新的 API Key
   *
   * @param userId 用户标识
   * @param role   用户角色
   * @returns ApiKeyRecord 包含完整 key（仅此一次）
   */
  generateApiKey(userId: string, role: Role): ApiKeyRecord {
    const rawKey = crypto.randomBytes(32)
    const apiKey = `agx_${rawKey.toString('base64url')}`
    const keyHash = this._hashKey(apiKey)
    const keyPrefix = apiKey.substring(0, 12) // "agx_" + 8 chars

    this.keys.set(keyHash, { userId, role, createdAt: Date.now(), enabled: true })
    this.prefixIndex.set(keyPrefix, keyHash)

    return {
      key: apiKey,
      keyPrefix,
      userId,
      role,
      createdAt: Date.now(),
      enabled: true,
    }
  }

  /**
   * 验证 API Key
   *
   * @param apiKey 完整的 API Key
   * @returns 如果有效返回 { userId, role }，否则 null
   */
  validateApiKey(apiKey: string): { userId: string; role: Role } | null {
    if (!apiKey.startsWith('agx_')) {
      return null
    }

    const keyHash = this._hashKey(apiKey)
    const record = this.keys.get(keyHash)
    if (!record || !record.enabled) {
      return null
    }

    return { userId: record.userId, role: record.role }
  }

  /**
   * 禁用 API Key（不可逆）
   */
  revokeApiKey(apiKey: string): boolean {
    const keyHash = this._hashKey(apiKey)
    const record = this.keys.get(keyHash)
    if (!record) return false
    record.enabled = false
    return true
  }

  /**
   * 按前缀禁用 API Key
   */
  revokeByPrefix(keyPrefix: string): boolean {
    const keyHash = this.prefixIndex.get(keyPrefix)
    if (!keyHash) return false
    return this.revokeByHash(keyHash)
  }

  /**
   * 按哈希禁用
   */
  revokeByHash(keyHash: string): boolean {
    const record = this.keys.get(keyHash)
    if (!record) return false
    record.enabled = false
    return true
  }

  /**
   * 检查前缀是否存在
   */
  hasPrefix(keyPrefix: string): boolean {
    return this.prefixIndex.has(keyPrefix)
  }

  /**
   * 获取所有活跃 key（不含完整 key，返回安全信息）
   */
  listActiveKeys(): Array<{ keyPrefix: string; userId: string; role: Role; createdAt: number }> {
    const result: Array<{ keyPrefix: string; userId: string; role: Role; createdAt: number }> = []
    for (const [keyHash, record] of this.keys) {
      if (record.enabled) {
        // 查找对应的 prefix
        let prefix = 'unknown'
        for (const [p, h] of this.prefixIndex) {
          if (h === keyHash) { prefix = p; break }
        }
        result.push({
          keyPrefix: prefix,
          userId: record.userId,
          role: record.role,
          createdAt: record.createdAt,
        })
      }
    }
    return result
  }

  /**
   * 从 HTTP Authorization header 提取并验证 API Key
   */
  authenticateFromHeader(authHeader: string | undefined): { userId: string; role: Role } | null {
    if (!authHeader) return null
    const parts = authHeader.split(' ')
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      // Bearer token — 尝试作为 API Key 验证
      return this.validateApiKey(parts[1])
    }
    // 无 scheme 或自定义 header — 尝试直接作为 API Key
    if (parts.length === 1 && parts[0].startsWith('agx_')) {
      return this.validateApiKey(parts[0])
    }
    return null
  }

  private _hashKey(apiKey: string): string {
    return crypto.createHash('sha256').update(apiKey).digest('hex')
  }
}

/** @deprecated */
export async function authenticateBasic(): Promise<string> {
  throw new Error('Basic Auth is deprecated. Use mTLS only.')
}

/** @deprecated */
export async function authenticateToken(): Promise<{ user: string; role: string } | null> {
  throw new Error('Token-based auth is deprecated. Use mTLS only.')
}

/** @deprecated */
export function requireAuth(): void {
  throw new Error('Token-based auth is deprecated. Use mTLS only.')
}
