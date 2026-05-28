/**
 * DatabaseManager — 单元测试
 *
 * 覆盖 createDatabase / getDatabase / dropDatabase / listDatabases / hasDatabase 的基本路径
 * 以及 dropDatabase 的资源清理行为（Phase 0 验证）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { DatabaseManager } from './database-manager'
import { ShardManager } from '../shard/shard-manager'

// ─── Helper: 监听 shardManager.stop() 调用 ───────────────────────────

vi.mock('../shard/shard-manager', () => {
  const MockShardManager = vi.fn()
  MockShardManager.prototype.start = vi.fn()
  MockShardManager.prototype.stop = vi.fn().mockResolvedValue(undefined)
  MockShardManager.prototype.upsertNode = vi.fn()
  MockShardManager.prototype.getNode = vi.fn()
  return { ShardManager: MockShardManager }
})

describe('DatabaseManager', () => {
  let dbm: DatabaseManager

  beforeEach(() => {
    dbm = new DatabaseManager({ baseDir: '/tmp/test-dbs' })
  })

  describe('createDatabase', () => {
    it('creates a new database with given name and config', async () => {
      const db = await dbm.createDatabase('orders', { shards: 2 })
      expect(dbm.hasDatabase('orders')).toBe(true)
      expect(db.config.name).toBe('orders')
    })

    it('throws if database already exists', async () => {
      await dbm.createDatabase('orders', { shards: 1 })
      await expect(dbm.createDatabase('orders', { shards: 1 })).rejects.toThrow(
        "Database 'orders' already exists"
      )
    })
  })

  describe('getDatabase / resolve', () => {
    it('returns the database instance for an existing database', async () => {
      await dbm.createDatabase('orders', { shards: 1 })
      const db = dbm.getDatabase('orders')
      expect(db.config.name).toBe('orders')
    })

    it('throws for a non-existent database', () => {
      expect(() => dbm.getDatabase('nonexistent')).toThrow(
        "Database 'nonexistent' not found"
      )
    })

    it('resolve is an alias of getDatabase', async () => {
      await dbm.createDatabase('test', { shards: 1 })
      expect(dbm.resolve('test')).toBe(dbm.getDatabase('test'))
    })
  })

  describe('hasDatabase', () => {
    it('returns true for existing databases', async () => {
      await dbm.createDatabase('orders', { shards: 1 })
      expect(dbm.hasDatabase('orders')).toBe(true)
    })

    it('returns false for non-existent databases', () => {
      expect(dbm.hasDatabase('nonexistent')).toBe(false)
    })
  })

  describe('listDatabases', () => {
    it('lists all database names', async () => {
      await dbm.createDatabase('a', { shards: 1 })
      await dbm.createDatabase('b', { shards: 1 })
      const names = dbm.listDatabases()
      expect(names).toContain('a')
      expect(names).toContain('b')
    })

    it('returns an empty array when no databases exist', () => {
      expect(dbm.listDatabases()).toEqual([])
    })
  })

  describe('dropDatabase (Phase 0)', () => {
    it('removes the database from the map', async () => {
      await dbm.createDatabase('orders', { shards: 1 })
      expect(dbm.hasDatabase('orders')).toBe(true)

      await dbm.dropDatabase('orders')
      expect(dbm.hasDatabase('orders')).toBe(false)
    })

    it('calls shardManager.stop() to release resources', async () => {
      await dbm.createDatabase('orders', { shards: 1 })
      const db = dbm.getDatabase('orders')
      const origStop = db.shardManager.stop.bind(db.shardManager)
      const stopSpy = vi.fn()
      db.shardManager.stop = stopSpy

      await dbm.dropDatabase('orders')

      expect(stopSpy).toHaveBeenCalled()
    })

    it('does not block deletion if shardManager.stop() throws', async () => {
      await dbm.createDatabase('orders', { shards: 1 })
      const db = dbm.getDatabase('orders')
      vi.spyOn(db.shardManager, 'stop').mockRejectedValueOnce(new Error('stop failed'))

      // Should not throw — error is logged but deletion continues
      await expect(dbm.dropDatabase('orders')).resolves.toBeUndefined()
      expect(dbm.hasDatabase('orders')).toBe(false)
    })

    it('throws if database not found', async () => {
      await expect(dbm.dropDatabase('nonexistent')).rejects.toThrow(
        "Database 'nonexistent' not found"
      )
    })
  })

  describe('getStats', () => {
    it('returns stats for all databases', async () => {
      await dbm.createDatabase('a', { shards: 2 })
      await dbm.createDatabase('b', { shards: 3 })
      const stats = dbm.getStats()
      expect(stats['a'].shardCount).toBe(2)
      expect(stats['b'].shardCount).toBe(3)
    })

    it('returns an empty object when no databases exist', () => {
      expect(dbm.getStats()).toEqual({})
    })
  })
})
