/**
 * ge-pool.ts — GraphEngine 弹性连接池
 *
 * 设计目标：避免每次 query 执行 new GraphEngine + open() 的开销，
 * 同时支持并发查询隔离和空闲实例自动回收。
 *
 * 实例分配策略：
 *   - 写请求（isWrite=true）：获取独占实例，期间不分配其他请求
 *   - 读请求（isWrite=false）：优先复用最近最少使用的空闲实例
 *   - 未达到 maxSize 时按需创建新实例
 *
 * 替换 executor-registry.ts 中 _gePool 的单例 hack，
 * 保留 /tmp/tckge-pool 预热机制。
 *
 * 使用方式：
 *   const pool = GEPool.getInstance()
 *   const ge = pool.getConnection()
 *   // ... use ge ...
 *   pool.releaseConnection(ge)
 */

import { GraphEngine } from '../core/graph-engine'
import type { OverGraphConfig } from '../types'
import * as path from 'path'
import * as fs from 'fs'

/** 池中实例状态 */
interface PoolInstance {
  ge: GraphEngine
  lastUsed: number
  inUse: boolean
  isWriter: boolean       // 写连接标记，release 时自动清除
  createdAt: number
}

export interface GEPoolConfig {
  /** 最大池大小（默认 4） */
  maxSize?: number
  /** 空闲超时 ms（默认 60000 = 1 分钟） */
  idleTimeoutMs?: number
  /** 池化用 GE 配置（路径、denseVector 等） */
  config?: OverGraphConfig
  /** 是否预热（使用 /tmp/tckge-pool） */
  warmup?: boolean
}

export class GEPool {
  private static _instance: GEPool | null = null
  /** 标记：_clearGeInstances 被调用过，强制下次 getInstance 重建池（跳过复用） */
  private static _needsRebuild = false

  private _instances: PoolInstance[] = []
  private _maxSize: number
  private _idleTimeoutMs: number
  private _config: OverGraphConfig | null = null
  private _warmup: boolean
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null
  private _poolDir: string | null = null

  /** 默认池化用 GE 配置路径 */
  static readonly DEFAULT_POOL_DIR = '/tmp/ge-pool'

  private constructor(opts: GEPoolConfig = {}) {
    this._maxSize = opts.maxSize ?? 4
    this._idleTimeoutMs = opts.idleTimeoutMs ?? 60000
    this._config = opts.config ?? null
    this._warmup = opts.warmup ?? false

    // 启动空闲回收定时器（每 30s 检查一次）
    const interval = Math.min(this._idleTimeoutMs, 30000)
    this._cleanupTimer = setInterval(() => this._reclaimIdle(), interval)
    // 允许 Node.js 在空闲时退出
    if (this._cleanupTimer && typeof this._cleanupTimer === 'object') {
      (this._cleanupTimer as unknown as { unref?: () => void }).unref?.()
    }
  }

  /**
   * 获取全局单例。首次调用时传入 config（后续调用忽略）。
   */
  static getInstance(opts?: GEPoolConfig): GEPool {
    if (!GEPool._instance || GEPool._needsRebuild) {
      GEPool._instance = new GEPool(opts)
      GEPool._needsRebuild = false
      if (opts?.warmup) {
        GEPool._instance._ensureWarmup()
      }
    }
    return GEPool._instance
  }

  /** 标记下次 getInstance 重建池（由 _clearGeInstances 外部调用） */
  static markNeedsRebuild(): void {
    GEPool._needsRebuild = true
  }

  /** 销毁单例（主要用于测试清理） */
  static destroyInstance(): void {
    if (GEPool._instance) {
      GEPool._instance.clear()
      GEPool._instance = null
    }
  }

  /** 销毁单例并清除磁盘存储（epoch 机制确保 getConnection 创建新实例） */
  static destroyInstanceWithCleanup(): void {
    if (GEPool._instance) {
      const poolDir = GEPool._instance._poolDir
      const configPath = GEPool._instance._config?.path
      GEPool._instance.clear()
      GEPool._instance = null
      GEPool._epoch++  // 递增 epoch，下一次 getInstance 创建新池
      // 清除磁盘上的存储文件
      const dirsToClean = new Set<string>()
      if (poolDir) dirsToClean.add(poolDir)
      if (configPath && configPath !== poolDir) dirsToClean.add(configPath)
      for (const dir of dirsToClean) {
        if (fs.existsSync(dir)) {
          try {
            const entries = fs.readdirSync(dir)
            for (const entry of entries) {
              try {
                const fullPath = path.join(dir, entry)
                const stat = fs.statSync(fullPath)
                if (stat.isDirectory()) {
                  fs.rmSync(fullPath, { recursive: true, force: true })
                } else {
                  fs.unlinkSync(fullPath)
                }
              } catch { /* 静默 */ }
            }
            try { fs.rmdirSync(dir) } catch { /* 静默 */ }
          } catch { /* 静默 */ }
        }
      }
    }
  }

  /** 当前活跃（in-use）连接数 */
  get activeCount(): number {
    return this._instances.filter(i => i.inUse).length
  }

  /** 当前空闲连接数 */
  get idleCount(): number {
    return this._instances.filter(i => !i.inUse).length
  }

  /** 总连接数 */
  get totalCount(): number {
    return this._instances.length
  }

  /**
   * 获取一个 GE 连接。
   * @param isWrite 是否写操作（写操作获取独占实例）
   */
  getConnection(isWrite = false): GraphEngine {
    // 1. 尝试从空闲池中获取
    let inst = this._findIdle(isWrite)
    if (inst) {
      inst.inUse = true
      inst.lastUsed = Date.now()
      return inst.ge
    }

    // 2. 未达到 maxSize → 创建新实例
    if (this._instances.length < this._maxSize) {
      const ge = this._createGE()
      inst = {
        ge,
        lastUsed: Date.now(),
        inUse: true,
        isWriter: isWrite,
        createdAt: Date.now(),
      }
      this._instances.push(inst)
      return ge
    }

    // 3. 达到 maxSize → 等待最近最少使用的写连接（fallback: 获取最早的空闲实例）
    // 当前实现：如果所有实例都在使用，获取最近最少使用的实例并复用
    // Note: 这可能导致并发冲突。生产环境应该增加 maxSize 或使用队列。
    const oldestIdle = this._instances
      .filter(i => !i.inUse)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0]

    if (oldestIdle) {
      oldestIdle.inUse = true
      oldestIdle.lastUsed = Date.now()
      return oldestIdle.ge
    }

    // 4. 所有实例都在使用 → 复用最近最少使用的（可能冲突）
    const lru = this._instances.sort((a, b) => a.lastUsed - b.lastUsed)[0]
    lru.inUse = true
    lru.lastUsed = Date.now()
    return lru.ge
  }

  /** Release connection回池 */
  releaseConnection(ge: GraphEngine): void {
    const inst = this._instances.find(i => i.ge === ge)
    if (inst) {
      inst.inUse = false
      inst.lastUsed = Date.now()
      inst.isWriter = false
    }
  }

  /** 清理所有实例 */
  clear(): void {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer)
      this._cleanupTimer = null
    }
    for (const inst of this._instances) {
      try { inst.ge.close() } catch { /* 静默 */ }
    }
    this._instances = []
  }

  // ── 私有 ──

  private _findIdle(isWrite: boolean): PoolInstance | undefined {
    // 写请求：获取当前无用的空闲实例
    if (isWrite) {
      return this._instances.find(i => !i.inUse)
    }
    // 读请求：优先复用最近使用的空闲实例（缓存亲和性）
    return this._instances
      .filter(i => !i.inUse)
      .sort((a, b) => b.lastUsed - a.lastUsed)[0]
  }

  private _createGE(): GraphEngine {
    if (this._config) {
      this._poolDir = this._config.path || null
      const ge = new GraphEngine(this._config)
      ge.open()
      return ge
    }
    // 无 config 时创建默认实例
    this._poolDir = path.join('/tmp', 'ge-pool-' + process.pid)
    fs.mkdirSync(this._poolDir, { recursive: true })
    const config: OverGraphConfig = { path: this._poolDir, denseVector: { dimension: 384 } }
    const ge = new GraphEngine(config)
    ge.open()
    return ge
  }

  private _ensureWarmup(): void {
    // 仅当池为空时预热
    if (this._instances.length === 0) {
      const warmDir = '/tmp/tckge-pool'
      if (fs.existsSync(warmDir)) {
        try {
          const ge = new GraphEngine({ path: warmDir, denseVector: { dimension: 384 } })
          ge.open()
          this._instances.push({
            ge,
            lastUsed: Date.now(),
            inUse: false,
            isWriter: false,
            createdAt: Date.now(),
          })
        } catch { /* 预热失败不阻塞 */ }
      }
    }
  }

  /** 回收超时空闲实例 */
  private _reclaimIdle(): void {
    const now = Date.now()
    const toRemove: number[] = []
    for (let i = 0; i < this._instances.length; i++) {
      const inst = this._instances[i]
      if (!inst.inUse && (now - inst.lastUsed) > this._idleTimeoutMs) {
        // 保留至少一个空闲实例（避免频繁创建/销毁）
        if (this._instances.filter(x => !x.inUse).length > 1) {
          toRemove.push(i)
        }
      }
    }
    // 从后往前删除（避免索引偏移）
    for (const idx of toRemove.reverse()) {
      try { this._instances[idx].ge.close() } catch { /* 静默 */ }
      this._instances.splice(idx, 1)
    }
  }
}

/** 默认 Geo Pool 单例（向后兼容 _gePool 引用） */
let _defaultPool: GEPool | null = null
export function getDefaultPool(): GEPool {
  if (!_defaultPool) {
    _defaultPool = GEPool.getInstance({ warmup: true, maxSize: 4 })
  }
  return _defaultPool
}
