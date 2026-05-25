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
   */
  async dropDatabase(name: string): Promise<void> {
    if (!this.databases.has(name)) {
      throw new Error(`Database '${name}' not found`)
    }

    // 等待清理
    await new Promise(resolve => setTimeout(resolve, 100))
    this.databases.delete(name)
    this.logger.info(`Database '${name}' dropped`)
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
