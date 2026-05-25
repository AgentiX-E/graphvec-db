// ============================================================
// Auth — mTLS 认证引擎（唯一认证方式）
//
// 只支持 mTLS 认证。证书 CN 用作用户标识，身份文件配置授权。
// ============================================================

import { AuthConfig, AuthResult, Role, AuthError } from '../types'

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

  constructor(config: AuthConfig) {
    if (config.mode !== 'mtls') {
      throw new Error('Auth: only mTLS mode is supported')
    }
    if (!config.tlsCert || !config.tlsKey) {
      throw new Error('Auth: tlsCert and tlsKey are required for mTLS mode')
    }
    this.config = config
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
        console.warn(`Auth: failed to load identities file "${this.config.identitiesFile}":`, (err as Error).message)
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
        console.log('Auth: identities file changed, reloading...')
        this._loadIdentities()
      })

      this._watcher = watcher
    } catch (err) {
      console.warn('Auth: chokidar not available, falling back to stat polling')
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
          console.log('Auth: identities file changed (poll), reloading...')
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
    console.log('Auth: identities reloaded')
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

  /** 获取角色的所有权限 */
  static getPermissions(role: Role): string[] {
    if (role === Role.ADMIN) return ['* (all)']
    return [...(RBAC.PERMISSIONS[role] || [])]
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

/** @deprecated */
export class RateLimiter {}

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
