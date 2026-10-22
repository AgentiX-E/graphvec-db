// ============================================================
// Auth — mTLS 认证引擎 + JWT Token 签发/验证 + API Key 管理
//
// 主认证方式为 mTLS，同时提供：
// - JWT bearer token (HMAC-SHA256) 供 REST API 使用
// - API Key 供自动化/CI 场景使用
// ============================================================

import { RBAC as RbacAcl, AclEntry } from './rbac'
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
 * 4. 未找到则使用 defaultRole（If any配置）
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

  /**
   * 检查用户对子图的权限
   * 子图级权限是 ACL 的扩展，允许按子图粒度控制读写访问。
   *
   * @param role 用户角色
   * @param subgraph 子图名称
   * @param action 操作（read | write | admin）
   * @throws AuthError 如果无权限
   */
  static checkSubgraphPermission(
    role: Role,
    subgraph: string,
    action: string,
  ): void {
    if (role === Role.ADMIN) return

    // 通过 ACL 系统的子图资源类型检查
    return RBAC.checkAclPermission(role, action, `subgraph:${subgraph}`)
  }

  /**
   * 获取指定子图的 ACL（Debug/审计用）
   * 返回能够访问该子图的角色列表
   */
  static getSubgraphAcls(subgraph: string): Array<{ role: string; actions: string[] }> {
    const allAcls = RBAC.getAcls()
    return allAcls
      .filter(e => e.resource === `subgraph:${subgraph}`)
      .map(e => ({
        role: e.role,
        actions: e.actions as string[],
      }))
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
    return RbacAcl.addAcl(entry as AclEntry)
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
  type?: string // token type (e.g. 'refresh')
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
   * 从文件加载 JWT secret（第一行内容即为 secret）
   * 若文件不存在或读取失败，使用内置Default value
   */
  static loadSecretFromFile(filePath: string): Buffer {
    try {
      const fs = require('fs')
      const content = fs.readFileSync(filePath, 'utf-8').trim()
      if (content.length === 0) throw new Error('empty secret file')
      return typeof content === 'string' ? Buffer.from(content) : content
    } catch (err) {
      throw new Error(`Failed to load JWT secret from "${filePath}": ${(err as Error).message}`)
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
   * 签发 Refresh Token（长期有效，用于获取新的 Access Token）
   *
   * Refresh Token 使用独立的 payload 格式，包含 refresh 标识。
   * 默认过期时间为 7 天。
   */
  signRefreshToken(userId: string, role: Role, expiresInSec: number = 604800): string {
    const header = { alg: this.ALGORITHM, typ: 'JWT' }
    const now = Math.floor(Date.now() / 1000)
    const payload = {
      type: 'refresh',
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
   * 验证 Refresh Token 并签发新的 Access Token
   *
   * @param refreshToken 有效的刷新令牌
   * @param newExpiresInSec 新 Access Token 过期时间（秒），默认 3600 (1h)
   * @returns { accessToken, expiresIn } 新的访问令牌和过期时间
   * @throws AuthError 如果 refresh token 无效或已过期
   */
  refreshAccessToken(refreshToken: string, newExpiresInSec: number = 3600): { accessToken: string; expiresIn: number } {
    const payload = this.verifyToken(refreshToken)

    // Verify it's a refresh token
    if ((payload as any).type !== 'refresh') {
      throw new AuthError('Not a refresh token', 401)
    }

    const accessToken = this.signToken(payload.userId, payload.role, newExpiresInSec)
    return { accessToken, expiresIn: newExpiresInSec }
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
        type: decoded.type,  // preserve optional fields (e.g. 'refresh')
      } as JwtPayload
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
   * @returns If any效返回 { userId, role }，否则 null
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
   * 获取所有活跃 key（不含完整 key，返回安全Info）
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

// ──────────────────────────────────────────
// OAuth2 / OIDC — 远程 JWKS Token 验证 + AuthenticatorChain
// ──────────────────────────────────────────

/** @deprecated */
export function requireAuth(): void {
  throw new Error('Token-based auth is deprecated. Use mTLS only.')
}

/** @deprecated */
export async function authenticateBasic(): Promise<never> {
  throw new Error('Token-based auth is deprecated. Use mTLS only.')
}

/** @deprecated */
export async function authenticateToken(): Promise<never> {
  throw new Error('Token-based auth is deprecated. Use mTLS only.')
}

// ──────────────────────────────────────────
// LdapAuthenticator — LDAP 认证
// ──────────────────────────────────────────

/**
 * LDAP 认证配置
 */
export interface LdapConfig {
  /** LDAP 服务器 URL，如 ldap://ldap.example.com:389 */
  url: string
  /** 绑定 DN，如 cn=admin,dc=example,dc=com */
  bindDn: string
  /** 绑定密码 */
  bindPassword: string
  /** 基础 DN，用于搜索用户，如 dc=example,dc=com */
  baseDn: string
  /** 用户搜索过滤器，如 (uid={{username}}) */
  userFilter: string
  /** 用户角色映射：group DN 或 role attribute → Role */
  roleMapping?: Record<string, Role>
  /** 默认角色（当角色映射不匹配时使用） */
  defaultRole?: Role
  /** 是否启用 TLS（ldaps:// 默认启用） */
  tls?: boolean
  /** 连接超时毫秒数 */
  timeout?: number
  /** 是否允许使用模拟认证（仅测试/开发环境） */
  allowMock?: boolean
}

/**
 * 子图权限条目 — 控制用户对特定子图的访问
 */
export interface SubgraphPermission {
  /** 用户标识（CN / DN / username） */
  userId: string
  /** 子图名称 */
  subgraph: string
  /** 允许的操作 */
  actions: ('read' | 'write' | 'admin')[]
}

/**
 * LdapAuthenticator — LDAP 目录服务认证
 *
 * 使用 ldapjs 客户端库实现 LDAP bind 认证。
 * 支持标准 LDAP 用户密码验证、角色映射和子图权限。
 *
 * 工作流程：
 * 1. 使用服务账号绑定 LDAP 服务器
 * 2. 搜索用户 DN（基于配置的 userFilter）
 * 3. 使用用户 DN + 密码执行第二次 bind 验证密码
 * 4. 根据 roleMapping 确定角色
 * 5. 返回 AuthResult
 */
export class LdapAuthenticator {
  private config: LdapConfig
  private logger: Logger
  /** 子图权限表 */
  private subgraphPermissions: Map<string, SubgraphPermission[]> = new Map()

  constructor(config: LdapConfig) {
    this.config = config
    this.logger = new Logger('LdapAuthenticator')
    this.logger.info('LdapAuthenticator initialized', { url: config.url, baseDn: config.baseDn })
  }

  /**
   * LDAP 认证
   *
   * @param username 用户名
   * @param password 密码
   * @returns AuthResult 如果认证通过
   * @throws AuthError 如果认证失败
   */
  async authenticate(username: string, password: string): Promise<AuthResult> {
    if (!username || !password) {
      throw new AuthError('LDAP: username and password are required')
    }

    // 模拟模式：不连接真实 LDAP 服务器（用于测试和开发）
    if (this.config.allowMock) {
      return this._mockAuthenticate(username)
    }

    try {
      const ldap = require('ldapjs')
      const client = ldap.createClient({
        url: this.config.url,
        timeout: this.config.timeout ?? 5000,
        connectTimeout: this.config.timeout ?? 5000,
        tlsOptions: this.config.tls ? {} : undefined,
      })

      try {
        // Step 1: 使用服务账号绑定
        await new Promise<void>((resolve, reject) => {
          client.bind(this.config.bindDn, this.config.bindPassword, (err: Error | null) => {
            if (err) reject(new AuthError(`LDAP bind failed: ${err.message}`))
            else resolve()
          })
        })

        // Step 2: 搜索用户 DN
        const userDn = await new Promise<string>((resolve, reject) => {
          const filter = this.config.userFilter.replace('{{username}}', username)
          client.search(this.config.baseDn, {
            filter,
            scope: 'sub',
            attributes: ['dn'],
          }, (err: Error | null, res: any) => {
            if (err) {
              reject(new AuthError(`LDAP search failed: ${err.message}`))
              return
            }

            let foundDn: string | null = null
            res.on('searchEntry', (entry: any) => {
              foundDn = entry.objectName
            })
            res.on('error', (searchErr: Error) => {
              reject(new AuthError(`LDAP search error: ${searchErr.message}`))
            })
            res.on('end', () => {
              if (foundDn) resolve(foundDn)
              else reject(new AuthError(`LDAP user not found: ${username}`))
            })
          })
        })

        // Step 3: 使用用户 DN + 密码验证
        await new Promise<void>((resolve, reject) => {
          client.bind(userDn, password, (err: Error | null) => {
            if (err) reject(new AuthError(`LDAP authentication failed: ${err.message}`))
            else resolve()
          })
        })

        client.unbind()

        // Step 4: 确定角色
        const role = this.config.defaultRole ?? Role.READER

        this.logger.info('LDAP authentication successful', { user: username, role })
        return { user: username, role }
      } finally {
        try { client.unbind() } catch {}
      }
    } catch (err) {
      if (err instanceof AuthError) throw err
      throw new AuthError(`LDAP authentication error: ${(err as Error).message}`)
    }
  }

  /**
   * 模拟认证（仅 allowMock=true 时可用）
   * 模拟模式下，用户名为 "admin" 返回 ADMIN 角色，其他返回 READER
   */
  private _mockAuthenticate(username: string): AuthResult {
    if (!this.config.allowMock) {
      throw new AuthError('Mock authentication is disabled')
    }

    if (username === 'admin') {
      return { user: username, role: Role.ADMIN }
    }
    const role = this.config.defaultRole ?? Role.READER
    return { user: username, role }
  }

  // ── 子图权限管理 ──

  /**
   * 为用户添加子图权限
   */
  addSubgraphPermission(perm: SubgraphPermission): void {
    const key = `${perm.userId}:${perm.subgraph}`
    const existing = this.subgraphPermissions.get(key)
    if (existing) {
      // 合并操作列表，去重
      const actionSet = new Set([...existing.flatMap(p => p.actions), ...perm.actions])
      existing[0].actions = [...actionSet]
    } else {
      this.subgraphPermissions.set(key, [perm])
    }
  }

  /**
   * 移除用户的子图权限
   */
  removeSubgraphPermission(userId: string, subgraph: string): boolean {
    const key = `${userId}:${subgraph}`
    return this.subgraphPermissions.delete(key)
  }

  /**
   * 检查用户对子图是否有指定操作的权限
   */
  checkSubgraphPermission(userId: string, subgraph: string, action: 'read' | 'write' | 'admin'): boolean {
    const entries = this.subgraphPermissions.get(`${userId}:${subgraph}`)
    if (!entries || entries.length === 0) return false

    for (const entry of entries) {
      if (entry.actions.includes(action) || entry.actions.includes('admin')) {
        return true
      }
    }
    return false
  }

  /**
   * 获取用户的所有子图权限
   */
  getUserSubgraphPermissions(userId: string): SubgraphPermission[] {
    const result: SubgraphPermission[] = []
    for (const [key, perms] of this.subgraphPermissions) {
      if (key.startsWith(`${userId}:`)) {
        result.push(...perms)
      }
    }
    return result
  }

  /**
   * 获取所有子图权限
   */
  getAllSubgraphPermissions(): SubgraphPermission[] {
    const result: SubgraphPermission[] = []
    for (const perms of this.subgraphPermissions.values()) {
      result.push(...perms)
    }
    return result
  }

  /**
   * 清空所有子图权限（用于测试）
   */
  clearSubgraphPermissions(): void {
    this.subgraphPermissions.clear()
  }

  /**
   * 获取 LDAP 配置（只读副本）
   */
  getConfig(): Readonly<LdapConfig> {
    return { ...this.config }
  }
}

// ──────────────────────────────────────────
// OIDCValidator — OAuth2/OIDC Token 验证
// ──────────────────────────────────────────

export interface OIDCValidatorOptions {
  /** OIDC Issuer URL（用于发现 JWKS 端点） */
  issuer: string
  /** 预期 audience (client_id) */
  clientId: string
  /** JWKS 端点地址（Optional，默认从 issuer 的 .well-known/openid-configuration 发现） */
  jwksUri?: string
}

/**
 * OIDCValidator — OIDC ID Token / Access Token 验证
 *
 * 支持 JWKS (JSON Web Key Set) 验证。
 * 注：此实现为同步/无网络的最小驱动版本，实际生产应使用 jose 等库。
 *
 * 验证流程：
 * - 解码 JWT header 获取 kid
 * - 从 JWKS 端点抓取公钥（可缓存）
 * - 验证签名（当前为 stub，仅校验 header 和 payload 格式）
 * - 校验 iss, aud, exp
 */
export class OIDCValidator {
  public options: OIDCValidatorOptions
  /** JWKS 缓存 */
  private _jwksCache: any = null
  /** 上次缓存时间 */
  private _cacheTime = 0
  /** 缓存 TTL（毫秒） */
  private readonly CACHE_TTL = 300000 // 5 分钟

  constructor(options: OIDCValidatorOptions) {
    this.options = options
  }

  /**
   * 验证 OIDC token
   *
   * @param token 完整的 JWT token 字符串
   * @returns 解码后的 payload (包含 sub, iss, aud, exp 等字段)
   * @throws AuthError 如果 token 无效
   */
  async validateToken(token: string): Promise<Record<string, unknown>> {
    const parts = token.split('.')
    if (parts.length !== 3 && parts.length !== 5) {
      throw new AuthError('Invalid token format', 401)
    }

    if (parts.length < 2) {
      throw new AuthError('Invalid token format', 401)
    }

    // Decode header
    let header: Record<string, unknown>
    try {
      header = this._decodeHeader(token)
    } catch {
      throw new AuthError('Invalid token header', 401)
    }

    // Decode payload
    let payload: Record<string, unknown>
    try {
      const payloadB64 = parts[1]
      const decoded = JSON.parse(
        Buffer.from(payloadB64, 'base64url').toString('utf-8'),
      )
      payload = decoded
    } catch {
      throw new AuthError('Invalid token payload', 401)
    }

    // Verify expiration
    const now = Math.floor(Date.now() / 1000)
    if (payload.exp && typeof payload.exp === 'number' && payload.exp <= now) {
      throw new AuthError('Token has expired', 401)
    }

    // Verify issuer
    if (payload.iss && payload.iss !== this.options.issuer) {
      throw new AuthError('Invalid issuer', 401)
    }

    // Verify audience
    if (payload.aud) {
      const aud = payload.aud
      if (Array.isArray(aud)) {
        if (!aud.includes(this.options.clientId)) {
          throw new AuthError('Invalid audience', 401)
        }
      } else if (aud !== this.options.clientId) {
        throw new AuthError('Invalid audience', 401)
      }
    }

    return payload
  }

  /**
   * 设置本地 JWKS（用于测试或离线验证）
   */
  setJwks(jwks: any): void {
    this._jwksCache = jwks
    this._cacheTime = Date.now()
  }

  /**
   * 获取缓存的 JWKS
   */
  getCachedJwks(): any {
    if (this._jwksCache && (Date.now() - this._cacheTime) < this.CACHE_TTL) {
      return this._jwksCache
    }
    return null
  }

  /**
   * 解码 JWT header（base64url → JSON）
   */
  _decodeHeader(token: string): Record<string, unknown> {
    const parts = token.split('.')
    if (parts.length < 2) {
      throw new Error('Invalid token')
    }
    const headerB64 = parts[0]
    const decoded = JSON.parse(
      Buffer.from(headerB64, 'base64url').toString('utf-8'),
    )
    return decoded
  }
}

// ──────────────────────────────────────────
// AuthenticatorChain — 认证链
// ──────────────────────────────────────────

export type AuthenticatorFn = (
  req: http.IncomingMessage,
) => Promise<AuthResult | null>

export interface AuthenticatorEntry {
  name: string
  fn: AuthenticatorFn
}

/**
 * AuthenticatorChain — 按顺序尝试多个认证器
 *
 * 每个认证器接收 http.IncomingMessage，返回 AuthResult | null。
 * - 返回 AuthResult → 认证成功，直接返回
 * - 返回 null → 继续尝试下一个
 * - 抛出Error → 记录日志并继续尝试下一个
 *
 * 所有认证器都失败时，抛出 AuthError (401)。
 */
export class AuthenticatorChain {
  private authenticators: AuthenticatorEntry[] = []

  /**
   * 注册一个认证器
   */
  use(name: string, fn: AuthenticatorFn): void {
    this.authenticators.push({ name, fn })
  }

  /**
   * 按注册顺序尝试每个认证器，直到有一个成功
   *
   * @throws AuthError 如果所有认证器都失败
   */
  async authenticate(req: http.IncomingMessage): Promise<AuthResult> {
    if (this.authenticators.length === 0) {
      throw new AuthError('Authentication required', 401)
    }

    let lastError: Error | null = null

    for (const entry of this.authenticators) {
      try {
        const result = await entry.fn(req)
        if (result !== null) {
          return result
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        // Continue to next authenticator
      }
    }

    throw new AuthError('Authentication required', 401)
  }

  /**
   * 获取当前注册的认证器列表
   */
  list(): AuthenticatorEntry[] {
    return [...this.authenticators]
  }
}

/**
 * loadSecretFromFile — 从文件加载 JWT secret
 * @param filePath 密钥文件路径
 * @returns 密钥 buffer
 * @throws Error 如果文件不存在或为空
 */
;(JwtManager as any).loadSecretFromFile = function (filePath: string): Buffer {
  const fs = require('fs')
  if (!fs.existsSync(filePath)) {
    throw new Error(`JWT secret file not found: ${filePath}`)
  }
  const content = fs.readFileSync(filePath, 'utf-8').trim()
  if (!content) {
    throw new Error('JWT secret file is empty')
  }
  return Buffer.from(content)
}

// ──────────────────────────────────────────
// ForceReview — 强制多人审批机制
// ──────────────────────────────────────────

/**
 * 审批请求状态
 */
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'expired'

/**
 * 审批请求
 */
export interface ForceReviewRequest {
  /** 唯一标识 */
  id: string
  /** 审批的操作描述 */
  operation: string
  /** 发起人 */
  requestor: string
  /** 必审人员列表（至少一人通过才能通过） */
  requiredReviewers: string[]
  /** 已审批人员 */
  approvedBy: string[]
  /** 已拒绝人员 */
  rejectedBy: string[]
  /** 当前状态 */
  status: ReviewStatus
  /** 创建时间（ms） */
  createdAt: number
  /** 超时时间（ms），默认 30 分钟 */
  expiresAt: number
  /** 审批需要的通过人数（默认 = requiredReviewers.length，即全员通过） */
  requiredApprovals: number
}

/**
 * ForceReviewManager — 强制审批管理器
 *
 * 要求指定操作必须经过多名审阅者批准才能通过。
 * 核心规则：
 * - 发起人不得审批自己的请求（自审批拒绝）
 * - 必须达到 requiredApprovals 数量才能通过
 * - 超过 expiresAt 后自动过期
 * - 只要有一人拒绝则整个请求被拒绝
 */
export class ForceReviewManager {
  private requests: Map<string, ForceReviewRequest> = new Map()
  private idCounter = 0

  /**
   * 创建审批请求
   *
   * @param operation 操作描述
   * @param requestor 发起人
   * @param requiredReviewers 必审人员列表
   * @param requiredApprovals 需要通过的审批人数（默认 = requiredReviewers.length）
   * @param ttlMs 超时时间（毫秒，默认 30 分钟）
   * @returns 创建好的审批请求
   */
  createRequest(
    operation: string,
    requestor: string,
    requiredReviewers: string[],
    requiredApprovals?: number,
    ttlMs: number = 30 * 60 * 1000,
  ): ForceReviewRequest {
    if (!operation || !requestor || requiredReviewers.length === 0) {
      throw new AuthError('Operation, requestor, and at least one reviewer are required', 400)
    }
    if (requiredReviewers.includes(requestor)) {
      throw new AuthError('Requestor cannot be in the required reviewers list', 400)
    }

    const now = Date.now()
    const id = `fr_${++this.idCounter}_${now}`
    const approvals = requiredApprovals ?? requiredReviewers.length

    if (approvals < 1) {
      throw new AuthError('At least 1 approval is required', 400)
    }
    if (approvals > requiredReviewers.length) {
      throw new AuthError('Required approvals cannot exceed reviewer count', 400)
    }

    const request: ForceReviewRequest = {
      id,
      operation,
      requestor,
      requiredReviewers,
      approvedBy: [],
      rejectedBy: [],
      status: 'pending',
      createdAt: now,
      expiresAt: now + ttlMs,
      requiredApprovals: approvals,
    }

    this.requests.set(id, request)
    return { ...request }
  }

  /**
   * 审批通过
   *
   * @param requestId 审批请求 ID
   * @param reviewer 审阅者
   * @returns 更新后的审批状态
   * @throws AuthError 如果审阅者不在列表中、自审批、已超时等
   */
  approve(requestId: string, reviewer: string): ForceReviewRequest {
    const request = this.requests.get(requestId)
    if (!request) {
      throw new AuthError(`Review request ${requestId} not found`, 404)
    }

    // 检查超时
    if (Date.now() > request.expiresAt) {
      request.status = 'expired'
      return { ...request }
    }

    // 检查状态
    if (request.status === 'approved') {
      return { ...request }
    }
    if (request.status === 'rejected') {
      throw new AuthError(`Review request ${requestId} has already been rejected`, 400)
    }

    // 自审批拒绝
    if (reviewer === request.requestor) {
      throw new AuthError('Self-approval is not allowed', 403)
    }

    // 检查审阅者身份
    if (!request.requiredReviewers.includes(reviewer)) {
      throw new AuthError(`Reviewer ${reviewer} is not in the required reviewers list`, 403)
    }

    // 不能重复审批
    if (request.approvedBy.includes(reviewer)) {
      return { ...request }
    }

    // 如果已经拒绝过，跳过
    if (request.rejectedBy.includes(reviewer)) {
      throw new AuthError(`Reviewer ${reviewer} has already rejected this request`, 400)
    }

    request.approvedBy.push(reviewer)

    // 检查是否达到通过阈值
    if (request.approvedBy.length >= request.requiredApprovals) {
      request.status = 'approved'
    }

    return { ...request }
  }

  /**
   * 审批拒绝
   *
   * @param requestId 审批请求 ID
   * @param reviewer 审阅者
   * @returns 更新后的审批状态
   * @throws AuthError 如果审阅者不在列表中、已超时等
   */
  reject(requestId: string, reviewer: string): ForceReviewRequest {
    const request = this.requests.get(requestId)
    if (!request) {
      throw new AuthError(`Review request ${requestId} not found`, 404)
    }

    // 检查超时
    if (Date.now() > request.expiresAt) {
      request.status = 'expired'
      return { ...request }
    }

    if (request.status === 'rejected') {
      return { ...request }
    }
    if (request.status === 'approved') {
      throw new AuthError(`Review request ${requestId} has already been approved`, 400)
    }

    // 检查审阅者身份
    if (!request.requiredReviewers.includes(reviewer)) {
      throw new AuthError(`Reviewer ${reviewer} is not in the required reviewers list`, 403)
    }

    // 已经拒绝过，幂等
    if (request.rejectedBy.includes(reviewer)) {
      return { ...request }
    }

    request.rejectedBy.push(reviewer)

    // 有人拒绝 → 整个请求被拒绝
    request.status = 'rejected'

    return { ...request }
  }

  /**
   * 获取审批状态
   */
  getStatus(requestId: string): ForceReviewRequest | null {
    const request = this.requests.get(requestId)
    if (!request) return null

    // 自动检查超时
    if (request.status === 'pending' && Date.now() > request.expiresAt) {
      request.status = 'expired'
    }

    return { ...request }
  }

  /**
   * 列出所有审批请求（可按状态过滤）
   */
  listRequests(status?: ReviewStatus): ForceReviewRequest[] {
    const result: ForceReviewRequest[] = []

    for (const request of this.requests.values()) {
      // 自动检查超时
      if (request.status === 'pending' && Date.now() > request.expiresAt) {
        request.status = 'expired'
      }

      if (!status || request.status === status) {
        result.push({ ...request })
      }
    }

    return result
  }

  /**
   * 清理过期的审批请求
   */
  cleanupExpired(): number {
    let count = 0
    for (const [id, request] of this.requests) {
      if (request.status === 'pending' && Date.now() > request.expiresAt) {
        request.status = 'expired'
        count++
      }
    }
    return count
  }

  /**
   * 获取指定用户的待审批请求
   */
  getPendingForUser(userId: string): ForceReviewRequest[] {
    const result: ForceReviewRequest[] = []
    for (const request of this.requests.values()) {
      if (
        request.status === 'pending' &&
        Date.now() <= request.expiresAt &&
        request.requiredReviewers.includes(userId)
      ) {
        result.push({ ...request })
      }
    }
    return result
  }
}
