"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseManager = void 0;
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
const path = __importStar(require("path"));
const shard_manager_1 = require("../shard/shard-manager");
const hlc_clock_1 = require("../replication/hlc-clock");
const logger_1 = require("../ops/logger");
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
class DatabaseManager {
    databases = new Map();
    baseDir;
    logger;
    constructor(options) {
        this.baseDir = options.baseDir;
        this.logger = options.logger ?? new logger_1.Logger('DatabaseManager');
    }
    /**
     * 解析数据库名称，返回对应的 DatabaseInstance
     * 如果数据库不存在则抛出错误
     */
    resolve(name) {
        const db = this.databases.get(name);
        if (!db) {
            throw new Error(`Database '${name}' not found`);
        }
        return db;
    }
    /**
     * 获取数据库（resolve 的别名）
     */
    getDatabase(name) {
        return this.resolve(name);
    }
    /**
     * 检查数据库是否存在
     */
    hasDatabase(name) {
        return this.databases.has(name);
    }
    /**
     * 列出所有数据库
     */
    listDatabases() {
        return Array.from(this.databases.keys());
    }
    /**
     * 创建新数据库
     *
     * @param name 数据库名称（用于 REST 路由路径）
     * @param config 数据库配置
     * @returns DatabaseInstance
     */
    async createDatabase(name, config) {
        if (this.databases.has(name)) {
            throw new Error(`Database '${name}' already exists`);
        }
        const dbDir = path.join(this.baseDir, name);
        const dbConfig = {
            name,
            dataDir: dbDir,
            shards: config.shards,
            peers: config.peers,
            raftPort: config.raftPort,
        };
        const clock = new hlc_clock_1.HlcClock();
        const shardCount = config.shards ?? 1;
        const peers = config.peers ?? [];
        const ports = [];
        // 生成 ShardMap 占位
        const ranges = [];
        for (let i = 0; i < shardCount; i++) {
            const rangeId = `${name}-range-${i}`;
            const rangeDir = path.join(dbDir, `range-${i}`);
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
            });
        }
        const shardMap = {
            version: Date.now(),
            ranges,
            hashRing: {
                virtualNodes: 100,
                nodes: ranges.map(r => ({
                    hash: r.rangeId,
                    rangeId: r.rangeId,
                })),
            },
        };
        // 初始化 ShardManager
        const shardManager = new shard_manager_1.ShardManager(shardMap, clock);
        this.logger.info(`Database '${name}' created at ${dbDir} with ${shardCount} shard(s)`);
        const instance = {
            shardManager,
            shardMap,
            config: dbConfig,
        };
        this.databases.set(name, instance);
        return instance;
    }
    /**
     * 删除数据库
     */
    async dropDatabase(name) {
        if (!this.databases.has(name)) {
            throw new Error(`Database '${name}' not found`);
        }
        // 等待清理
        await new Promise(resolve => setTimeout(resolve, 100));
        this.databases.delete(name);
        this.logger.info(`Database '${name}' dropped`);
    }
    /**
     * 获取所有数据库统计信息
     */
    getStats() {
        const stats = {};
        for (const [name, db] of this.databases) {
            stats[name] = {
                shardCount: Object.keys(db.shardMap.ranges).length,
                dataDir: db.config.dataDir,
            };
        }
        return stats;
    }
}
exports.DatabaseManager = DatabaseManager;
//# sourceMappingURL=database-manager.js.map