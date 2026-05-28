/**
 * DatabaseManager — 虚拟多数据库管理器
 *
 * OverGraph 是单数据库单文件夹存储，DatabaseManager 在应用层实现
 * 虚拟多数据库 + 路由。
 *
 * 架构：
 * ```
 * REST /api/v1/:db/graph/node
 *                    ^^^^
 *                    DatabaseManager.resolve('mydb')
 *                      → GraphEngine + ShardManager (在 mydb/ 子目录)
 * ```
 *
 * 每个数据库：
 * - 物理存储：{dataDir}/{dbName}/   （独立的 LMDB/OverGraph/Raft WAL 空间）
 * - Raft 集群：独立的 RangeInstance 列表
 * - 认证：独立的身份 scope（用户在数据库级别授权）
 * - 隔离：数据库之间完全独立，互不感知
 */
import * as path from 'path'
import * as fs from 'fs'
import { ShardManager } from '../shard/shard-manager'
import { HlcClock } from '../replication/hlc-clock'
import { ShardMap, RangeConfig } from '../types'
import { Logger } from '../ops/logger'

export interface DatabaseConfig {
  name: string
  dataDir: string
  raftPort?: number
  shards?: number
  peers?: string[]
}

export interface DatabaseInstance {
  shardManager: ShardManager
  shardMap: ShardMap
  config: DatabaseConfig
}

/**
 * 墓碑文件结构 — 参见 docs/multi-database-arch-design.md §8.3
 */
export interface Tombstone {
  /** 数据库名 */
  database: string
  /** 删除请求发起时间 (ISO-8601) */
  requestedAt: string
  /** 冷静期时长 (秒)，默认 3600 */
  gracePeriodSeconds: number
  /** GC 最早可执行时间 = requestedAt + gracePeriod */
  gcEarliestAt: string
  /** 当前阶段 */
  phase: 'proposing' | 'tombstone-committed' | 'gc-ready' | 'gc-complete'
  /** 已确认 tombstone 的节点列表 */
  ackNodes: string[]
  /** 数据库所属的所有 RaftGroup ID 列表 */
  groupIds: string[]
  /** 回滚时间（可选） */
  restoredAt?: string
}

/** 数据库内部状态（扩展实例，仅运行时使用） */
export interface DatabaseDeletionState {
  tombstone?: Tombstone
}

/**
 * 数据库管理器
 *
 * 用法：
 * ```ts
 * const dbm = new DatabaseManager({ baseDir: '/data/overgraph' })
 * const db1 = await dbm.createDatabase('orders', { shards: 4 })
 * const db2 = await dbm.createDatabase('inventory', { shards: 2 })
 *
 * const orders = dbm.getDatabase('orders')
 * await orders.shardManager.upsertNode(1, 'node1')
 * ```
 */
export class DatabaseManager {
  private databases = new Map<string, DatabaseInstance>()
  private baseDir: string
  private logger: Logger

  constructor(options: { baseDir: string; logger?: Logger }) {
    this.baseDir = options.baseDir
    this.logger = options.logger ?? new Logger('DatabaseManager')
  }

  /**
   * 解析数据库名称，返回对应的 DatabaseInstance
   * 如果数据库不存在则抛出错误
   */
  resolve(name: string): DatabaseInstance {
    const db = this.databases.get(name)
    if (!db) {
      throw new Error(`Database '${name}' not found`)
    }
    return db
  }

  /**
   * 获取数据库（resolve 的别名）
   */
  getDatabase(name: string): DatabaseInstance {
    return this.resolve(name)
  }

  /**
   * 检查数据库是否存在
   */
  hasDatabase(name: string): boolean {
    return this.databases.has(name)
  }

  /**
   * 列出所有数据库
   */
  listDatabases(): string[] {
    return Array.from(this.databases.keys())
  }

  /**
   * 创建新数据库
   *
   * @param name 数据库名称（用于 REST 路由路径）
   * @param config 数据库配置
   * @returns DatabaseInstance
   */
  async createDatabase(name: string, config: Omit<DatabaseConfig, 'name'>): Promise<DatabaseInstance> {
    if (this.databases.has(name)) {
      throw new Error(`Database '${name}' already exists`)
    }

    const dbDir = path.join(this.baseDir, name)
    const dbConfig: DatabaseConfig = {
      name,
      dataDir: dbDir,
      shards: config.shards,
      peers: config.peers,
      raftPort: config.raftPort,
    }

    const clock = new HlcClock()
    const shardCount = config.shards ?? 1
    const peers = config.peers ?? []
    const ports: number[] = []

    // 生成 ShardMap 占位
    const ranges: RangeConfig[] = []

    for (let i = 0; i < shardCount; i++) {
      const rangeId = `${name}-range-${i}`
      const rangeDir = path.join(dbDir, `range-${i}`)
      ranges.push({
        rangeId,
        dataDir: rangeDir,
        raftConfig: {
          nodeId: `${name}-${i}`,
          peers: [],
          storagePath: rangeDir,
        },
        overgraphConfig: {
          path: rangeDir,
        },
      })
    }

    const shardMap: ShardMap = {
      version: Date.now(),
      ranges,
      hashRing: {
        virtualNodes: 100,
        nodes: ranges.map(r => ({
          hash: r.rangeId,
          rangeId: r.rangeId,
        })),
      },
    }

    // 初始化 ShardManager
    const shardManager = new ShardManager(shardMap, clock)
    this.logger.info(`Database '${name}' created at ${dbDir} with ${shardCount} shard(s)`)

    const instance: DatabaseInstance = {
      shardManager,
      shardMap,
      config: dbConfig,
    }

    this.databases.set(name, instance)
    return instance
  }

  /**
   * 删除数据库
   *
   * ⚠️ Phase 0 实现：调用 shardManager.stop() 释放 Raft + GraphEngine 资源
   * 然后在 Phase 0 成功后写入 tombstone（Phase 1）。
   *
   * 完整三阶段删除（Phase 0/1/2/3）见 docs/multi-database-arch-design.md §8
   *
   * @param name 数据库名称
   * @param options.gracePeriodSeconds 冷静期时长（秒），默认 3600 (1h)
   */
  async dropDatabase(name: string, options?: { gracePeriodSeconds?: number }): Promise<void> {
    const db = this.databases.get(name)
    if (!db) {
      throw new Error(`Database '${name}' not found`)
    }

    this.logger.info(`[Drop] Stopping all ranges for database '${name}'`)

    // Phase 0: 最少必要清理 — 停止 Raft 引擎 + 关闭 GraphEngine 文件
    try {
      await db.shardManager.stop()
      this.logger.info(`[Drop] All ranges for '${name}' stopped successfully`)
    } catch (err) {
      this.logger.error(`[Drop] Error stopping ranges for '${name}': ${err}`)
      // 继续执行，不阻塞删除
    }

    // Phase 1: Phase 0 成功后写入 tombstone.json
    const gracePeriod = options?.gracePeriodSeconds ?? 3600
    const now = new Date()
    const tombstone: Tombstone = {
      database: name,
      requestedAt: now.toISOString(),
      gracePeriodSeconds: gracePeriod,
      gcEarliestAt: new Date(now.getTime() + gracePeriod * 1000).toISOString(),
      phase: 'proposing',
      ackNodes: [],
      groupIds: this._getGroupIds(db),
    }
    await this._writeTombstone(name, tombstone)
    this.logger.info(`[Drop] Tombstone written for '${name}' (grace=${gracePeriod}s, gcEarliest=${tombstone.gcEarliestAt})`)

    this.logger.info(`[Drop] Database '${name}' dropped`)
    this.databases.delete(name)
  }

  /**
   * Phase 2: 冷静期内回滚删除 — 移除墓碑，恢复数据库
   *
   * 注意：当前实现在 dropDatabase() Phase 0 之后已将数据库从 active map 中移除，
   * 所以 restoreDatabase 需要重新注册数据库。
   *
   * 如果数据库仍为 active 状态，则无法执行回滚（无需回滚）。
   * 需要先创建同名数据库的实例后再调用回滚。
   *
   * @param name 数据库名称
   * @param dbInstance 重新注册的数据库实例（若 dropDatabase 后需要恢复活跃状态）
   */
  async restoreDatabase(name: string): Promise<void> {
    const tombstonePath = this._tombstonePath(name)

    // 检查 tombstone 文件是否存在
    let tombstone: Tombstone
    try {
      const content = await fs.promises.readFile(tombstonePath, 'utf-8')
      tombstone = JSON.parse(content) as Tombstone
    } catch {
      throw new Error(`Database '${name}' has no tombstone, cannot restore`)
    }

    // 检查是否已过冷静期 — 已过冷静期的只能 GC，不能回滚
    const now = Date.now()
    const gcEarliest = new Date(tombstone.gcEarliestAt).getTime()
    if (now >= gcEarliest) {
      throw new Error(
        `Cannot restore database '${name}': grace period has expired (gcEarliest=${tombstone.gcEarliestAt})`
      )
    }

    this.logger.info(`[Restore] Removing tombstone for '${name}'`)

    // 1. 清除墓碑文件
    await this._removeTombstone(name)

    // 2. 如果数据库从 map 中被移除，我们无法自动恢复 active 状态
    //    因为 RangeInstance / ShardManager 等需要重新构建
    //    这里只清除 tombstone，调用方需要重新 createDatabase 或重新注册
    this.logger.info(`[Restore] Tombstone removed for '${name}'. Database restored (tombstone cleared)`)

    // 3. 记录回滚时间
    tombstone.restoredAt = new Date().toISOString()
  }

  /**
   * Phase 3: GC 清理 — 检查所有 tombstone 是否过期，执行物理删除
   *
   * 遍历 baseDir 下所有目录，检查每个目录中是否存在 tombstone.json，
   * 如果 tombstone 已过期（gcEarliestAt < now），则执行物理删除。
   */
  async gcDatabases(): Promise<string[]> {
    const cleaned: string[] = []
    const entries = await fs.promises.readdir(this.baseDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dbDir = path.join(this.baseDir, entry.name)
      const tombstonePath = path.join(dbDir, '.tombstone.json')

      let tombstone: Tombstone
      try {
        const content = await fs.promises.readFile(tombstonePath, 'utf-8')
        tombstone = JSON.parse(content) as Tombstone
      } catch {
        // 无 tombstone 文件，跳过
        continue
      }

      const now = Date.now()
      const gcEarliest = new Date(tombstone.gcEarliestAt).getTime()

      if (now >= gcEarliest) {
        this.logger.info(`[GC] Cleaning up database '${entry.name}' (gcEarliest=${tombstone.gcEarliestAt})`)
        // 如果数据库还在 active map 中，先停止 shardManager
        const db = this.databases.get(entry.name)
        if (db) {
          try {
            await db.shardManager.stop()
          } catch (err) {
            this.logger.error(`[GC] Error stopping shardManager for '${entry.name}': ${err}`)
          }
          this.databases.delete(entry.name)
        }

        // 物理删除整个目录
        try {
          fs.rmSync(dbDir, { recursive: true, force: true })
          this.logger.info(`[GC] Directory '${dbDir}' removed`)
          cleaned.push(entry.name)
        } catch (err) {
          this.logger.error(`[GC] Failed to remove directory '${dbDir}': ${err}`)
        }
      }
    }

    return cleaned
  }

  /**
   * cleanupDeletedDatabases — gcDatabases 的别名
   */
  async cleanupDeletedDatabases(): Promise<string[]> {
    return this.gcDatabases()
  }

  // ── 私有辅助方法 ──────────────────────────────────────────────────

  /** 返回墓碑文件的完整路径 */
  private _tombstonePath(name: string): string {
    return path.join(this.baseDir, name, '.tombstone.json')
  }

  /** 返回数据库目录的完整路径 */
  private _databaseDir(name: string): string {
    return path.join(this.baseDir, name)
  }

  /** 从 DatabaseInstance 提取所有 RaftGroup ID（基于 RangeConfig） */
  private _getGroupIds(db: DatabaseInstance): string[] {
    return db.shardMap.ranges.map(r => r.rangeId)
  }

  /** 写入 tombstone 文件到数据库目录 */
  private async _writeTombstone(name: string, tombstone: Tombstone): Promise<void> {
    const dbDir = this._databaseDir(name)
    // 确保目录存在
    await fs.promises.mkdir(dbDir, { recursive: true })
    const content = JSON.stringify(tombstone, null, 2)
    await fs.promises.writeFile(this._tombstonePath(name), content, 'utf-8')
  }

  /** 删除 tombstone 文件 */
  private async _removeTombstone(name: string): Promise<void> {
    const tp = this._tombstonePath(name)
    try {
      await fs.promises.unlink(tp)
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  /**
   * 获取所有数据库统计信息
   */
  getStats(): Record<string, { shardCount: number; dataDir: string }> {
    const stats: Record<string, { shardCount: number; dataDir: string }> = {}
    for (const [name, db] of this.databases) {
      stats[name] = {
        shardCount: Object.keys(db.shardMap.ranges).length,
        dataDir: db.config.dataDir,
      }
    }
    return stats
  }
}
