/**
 * config-watcher.ts — 配置热加载管理
 *
 * 复用 chokidar（已有依赖）实现配置文件变更监听。
 * 支持按配置项注册回调，变更后即时生效，无需重启服务。
 *
 * 与已有 TLSConfig.startCertWatcher() 和 Authenticator chokidar 使用
 * 互不冲突，可并存。本模块提供更通用的配置级热加载模式。
 *
 * @example
 * ```ts
 * const watcher = new ConfigWatcher('/etc/agentix/config.json', initialConfig)
 * watcher.on('overgraph.compactAfterNFlushes', (event) => {
 *   engine.updateConfig({ overgraph: { compactAfterNFlushes: event.newValue } })
 * })
 * watcher.start()
 * ```
 */

import * as fs from 'fs'
import * as path from 'path'

// 动态导入 chokidar（ESM-only，已在 package.json 中声明）
let chokidar: typeof import('chokidar') | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  chokidar = require('chokidar')
} catch {
  // chokidar 不可用时降级
}

/**
 * 配置变更事件
 */
export interface ConfigChangeEvent<T = unknown> {
  /** 变更的配置键 */
  key: string
  /** 变更前的值 */
  previousValue: T | undefined
  /** 变更后的新值 */
  newValue: T
  /** 事件发生时间 */
  timestamp: Date
}

/**
 * 配置变更回调
 */
export type ConfigChangeHandler<T = unknown> = (event: ConfigChangeEvent<T>) => void | Promise<void>

type AnyRecord = Record<string, unknown>

/**
 * ConfigWatcher — 通用配置热加载器
 *
 * 监听 JSON 配置文件变更，解析后按配置项触发回调。
 * 支持嵌套键（如 `overgraph.compactAfterNFlushes`）。
 */
export class ConfigWatcher<T extends AnyRecord = AnyRecord> {
  private configPath: string
  private currentConfig: T
  private handlers = new Map<string, Set<ConfigChangeHandler>>()
  private anyHandlers = new Set<ConfigChangeHandler>()
  private watcher: ReturnType<typeof chokidar['watch']> | null = null
  private watcherInitialized = false
  private _isWatching = false

  /**
   * @param configPath - JSON 配置文件路径
   * @param initialConfig - 初始配置（启动时不触发回调）
   */
  constructor(configPath: string, initialConfig: T) {
    this.configPath = path.resolve(configPath)
    this.currentConfig = { ...initialConfig }
  }

  /**
   * 获取当前配置的只读快照
   */
  getConfig(): Readonly<T> {
    return Object.freeze({ ...this.currentConfig })
  }

  /**
   * 更新运行时配置值（不触发文件监听回调）
   */
  setConfig(partial: Partial<T>): void {
    const previous = { ...this.currentConfig }
    this.currentConfig = { ...this.currentConfig, ...partial }
    this.fireHandlers(previous)
  }

  /**
   * 监听特定配置项的变更
   *
   * @param key - 配置键（支持点号路径，如 `overgraph.compactAfterNFlushes`）
   * @param handler - 变更回调
   */
  on<K extends keyof T>(key: K, handler: ConfigChangeHandler<T[K]>): void {
    const keyStr = String(key)
    if (!this.handlers.has(keyStr)) {
      this.handlers.set(keyStr, new Set())
    }
    this.handlers.get(keyStr)!.add(handler as ConfigChangeHandler)
  }

  /**
   * 监听任意配置项变更
   */
  onAny(handler: ConfigChangeHandler): void {
    this.anyHandlers.add(handler)
  }

  /**
   * 移除特定配置项的监听器
   */
  off<K extends keyof T>(key: K, handler: ConfigChangeHandler<T[K]>): void {
    const set = this.handlers.get(String(key))
    if (set) {
      set.delete(handler as ConfigChangeHandler)
      if (set.size === 0) {
        this.handlers.delete(String(key))
      }
    }
  }

  /**
   * 从文件重新加载配置
   * 对比当前值，对每个变更的键触发回调
   */
  async reload(): Promise<void> {
    const previous = { ...this.currentConfig }
    const parsed = await this.readConfigFile()
    if (parsed === null) return
    this.currentConfig = { ...this.currentConfig, ...parsed } as T
    this.fireHandlers(previous)
  }

  /**
   * 开始文件监听
   * 仅在 chokidar 可用时启用真实文件监听；否则回退到手动 reload()
   */
  start(): void {
    if (this._isWatching) return
    this._isWatching = true

    if (!chokidar) {
      return // 无 chokidar 时静默降级
    }

    // 确保监听的目录存在
    const dir = path.dirname(this.configPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    this.watcher = chokidar.watch(this.configPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    })

    this.watcher.on('change', async () => {
      await this.reload()
    })

    this.watcher.on('error', (err: Error) => {
      // 文件变更失败时静默处理（避免崩溃）
      console.error(`[ConfigWatcher] File watch error: ${err.message}`)
    })

    this.watcherInitialized = true
  }

  /**
   * 停止文件监听
   */
  async stop(): Promise<void> {
    this._isWatching = false
    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }
    this.watcherInitialized = false
  }

  /**
   * 是否正在监听
   */
  get isWatching(): boolean {
    return this._isWatching
  }

  // ── 内部方法 ──────────────────────────────

  /**
   * 读取并解析 JSON 配置文件
   */
  private async readConfigFile(): Promise<AnyRecord | null> {
    try {
      if (!fs.existsSync(this.configPath)) {
        return null
      }
      const raw = fs.readFileSync(this.configPath, 'utf-8')
      return JSON.parse(raw) as AnyRecord
    } catch (err) {
      console.error(`[ConfigWatcher] Failed to parse config file: ${(err as Error).message}`)
      return null
    }
  }

  /**
   * 对比新旧配置，触发响应回调
   */
  private fireHandlers(previous: T): void {
    const now = new Date()

    for (const key of Object.keys(this.currentConfig)) {
      const prevVal = (previous as AnyRecord)[key]
      const newVal = (this.currentConfig as AnyRecord)[key]

      // 值未变更时跳过
      if (JSON.stringify(prevVal) === JSON.stringify(newVal)) {
        continue
      }

      const event: ConfigChangeEvent = {
        key,
        previousValue: prevVal,
        newValue: newVal,
        timestamp: now,
      }

      // 通知特定键的监听器
      const keyHandlers = this.handlers.get(key)
      if (keyHandlers) {
        for (const handler of keyHandlers) {
          this.invokeHandler(handler, event)
        }
      }

      // 通知通配监听器
      for (const handler of this.anyHandlers) {
        this.invokeHandler(handler, event)
      }
    }
  }

  /**
   * 安全调用回调（支持 async/sync）
   */
  private invokeHandler(handler: ConfigChangeHandler, event: ConfigChangeEvent): void {
    try {
      const result = handler(event)
      if (result instanceof Promise) {
        result.catch((err) => {
          console.error(`[ConfigWatcher] Handler error for key "${event.key}":`, err)
        })
      }
    } catch (err) {
      console.error(`[ConfigWatcher] Handler error for key "${event.key}":`, err)
    }
  }
}
