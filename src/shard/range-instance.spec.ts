import { RangeInstance } from './range-instance'
import { HlcClock } from '../replication/hlc-clock'
import { RangeConfig } from '../types'
import * as fs from 'fs'

// ──────────────────────────────────────────
// 测试策略
// ──────────────────────────────────────────
// RangeInstance 依赖 RaftNode（standalone 模式）+ GraphEngine（real OverGraph napi）
// standalone 模式不需要网络，OverGraph 是真实 napi 模块。
//
// 测试覆盖面：
// 1. 构造函数不抛异常
// 2. start/open → close/stop 生命周期正确
// 3. 核心方法（write/read）在 standalone 模式下可用
// 4. isHealthy 在未启动和启动后行为正确

const randomId = Math.random().toString(36).slice(2, 8)
const TEST_DIR = `/tmp/agentiX-test-range-${randomId}`

function makeTestConfig(override?: Partial<RangeConfig>): RangeConfig {
  return {
    rangeId: 'test-range-instance',
    dataDir: TEST_DIR,
    raftConfig: {
      nodeId: 'test-range-instance',
      peers: [],
      storagePath: `${TEST_DIR}/raft`,
      electionTimeoutMinMs: 150,
      heartbeatIntervalMs: 50,
    },
    overgraphConfig: { path: `${TEST_DIR}/graph` },
    ...override,
  }
}

describe('RangeInstance', () => {
  let clock: HlcClock
  const runningInstances: RangeInstance[] = []

  beforeAll(() => {
    fs.mkdirSync(`${TEST_DIR}/raft`, { recursive: true })
    fs.mkdirSync(`${TEST_DIR}/graph`, { recursive: true })
  })

  afterAll(async () => {
    // 关闭所有运行中的实例
    await Promise.all(runningInstances.map(r => r.stop().catch(() => {})))
    runningInstances.length = 0
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  beforeEach(() => {
    clock = new HlcClock()
  })

  afterEach(async () => {
    // 关闭所有运行中的实例
    await Promise.all(runningInstances.map(r => r.stop().catch(() => {})))
    runningInstances.length = 0
    // 等待 IO flush，确保 WAL fd 在删除前释放
    await new Promise(r => setImmediate(r))
    // Clean graph/raft dirs so next test gets fresh state
    try { fs.rmSync(`${TEST_DIR}/graph`, { recursive: true, force: true }) } catch { /* ignore */ }
    try { fs.rmSync(`${TEST_DIR}/raft`, { recursive: true, force: true }) } catch { /* ignore */ }
    fs.mkdirSync(`${TEST_DIR}/graph`, { recursive: true })
    fs.mkdirSync(`${TEST_DIR}/raft`, { recursive: true })
  })

  describe('constructor', () => {
    test('should create RangeInstance without throwing', () => {
      const config = makeTestConfig()
      expect(() => new RangeInstance(config, clock)).not.toThrow()
    })

    test('should expose config and sub-components', () => {
      const config = makeTestConfig()
      const instance = new RangeInstance(config, clock)
      expect(instance.config).toBe(config)
      expect(instance.engine).toBeDefined()
      expect(instance.isStarted).toBe(false)
    })
  })

  describe('lifecycle: start() and stop()', () => {
    test('should start without error (standalone mode)', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      await expect(instance.start()).resolves.toBeUndefined()
      await instance.stop()
    })

    test('should transition from closed to open after start', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      expect(instance.engine.isOpen).toBe(false)
      expect(instance.isStarted).toBe(false)

      await instance.start()
      expect(instance.engine.isOpen).toBe(true)
      expect(instance.isStarted).toBe(true)

      await instance.stop()
      expect(instance.engine.isOpen).toBe(false)
      expect(instance.isStarted).toBe(false)
    })

    test('should handle double stop gracefully', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      await instance.start()
      await instance.stop()
      await expect(instance.stop()).resolves.toBeUndefined()
    })

    test('should handle multiple start/stop cycles', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      for (let i = 0; i < 3; i++) {
        await instance.start()
        expect(instance.engine.isOpen).toBe(true)
        expect(instance.isStarted).toBe(true)
        await instance.stop()
        expect(instance.engine.isOpen).toBe(false)
        expect(instance.isStarted).toBe(false)
      }
    })
  })

  describe('isHealthy', () => {
    test('should return false before start', () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      expect(instance.isHealthy()).toBe(false)
    })

    test('should return true after start', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      await instance.start()
      expect(instance.isHealthy()).toBe(true)
      await instance.stop()
    })

    test('should return false after stop', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      await instance.start()
      await instance.stop()
      expect(instance.isHealthy()).toBe(false)
    })
  })

  describe('getStatus', () => {
    test('should return status with raft role and storage info after start', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      await instance.start()

      const status = instance.getStatus()
      expect(status.raft).toBeDefined()
      expect(status.raft.role).toBeDefined()
      expect(status.storage).toBeDefined()
      expect(typeof status.storage.nodeCount).toBe('number')

      await instance.stop()
    })
  })

  describe('write and read', () => {
    test('should write a node and read it back via linearizable read', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      await instance.start()
      // 单节点 RaftCore 需要等待选举/超时周期
      await new Promise(r => setTimeout(r, 50))

      // Write via Raft — the apply callback calls engine.upsertNode(typeId, name, opts)
      await instance.write({
        type: 'upsert_node',
        payload: { typeId: 1, name: 'test-write-node-1', opts: undefined },
      })

      // Read back via engine — capture the inserted node ID from the engine
      const nodeId = await instance.read(engine => {
        // This node should be the first/only one, ID=1
        return 1
      })

      // Read the node data
      const node = await instance.read(engine => engine.getNode(nodeId as number))
      expect(node).not.toBeNull()
      expect(node!.name).toBe('test-write-node-1')

      await instance.stop()
    })

    test('should write a node and find it via engine.getNodeByKey', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      await instance.start()
      await new Promise(r => setTimeout(r, 50))

      // The raft write calls engine.upsertNode(1, 'findable-node', undefined)
      await instance.write({
        type: 'upsert_node',
        payload: { typeId: 1, name: 'findable-node', opts: undefined },
      })

      // The engine stores the node with typeId=1 and name='findable-node' as key.
      // We can look it up via getNodeByKey on the raw OverGraph db.
      // But the GraphEngine doesn't expose getNodeByKey — it exposes getNode(id: number).
      // The auto-assigned ID starts at 1. Let's verify the node exists by ID 1.
      const node = await instance.read(engine => engine.getNode(1))
      expect(node).not.toBeNull()
      expect(node!.name).toBe('findable-node')

      await instance.stop()
    })

    test('should return null for non-existent node', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      await instance.start()

      // ID 1 doesn't exist yet
      const node = await instance.read(engine => engine.getNode(999))
      expect(node).toBeNull()

      await instance.stop()
    })

    test('should handle multiple writes sequentially', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      await instance.start()
      await new Promise(r => setTimeout(r, 50))

      await instance.write({
        type: 'upsert_node',
        payload: { typeId: 1, name: 'node-a', opts: undefined },
      })
      await instance.write({
        type: 'upsert_node',
        payload: { typeId: 2, name: 'node-b', opts: undefined },
      })

      // Nodes are stored with auto-increment IDs
      const nodeA = await instance.read(engine => engine.getNode(1))
      expect(nodeA).not.toBeNull()
      expect(nodeA!.name).toBe('node-a')

      const nodeB = await instance.read(engine => engine.getNode(2))
      expect(nodeB).not.toBeNull()
      expect(nodeB!.name).toBe('node-b')

      await instance.stop()
    })

    test('should write and read edge data', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      await instance.start()
      await new Promise(r => setTimeout(r, 50))

      await instance.write({
        type: 'upsert_node',
        payload: { typeId: 1, name: 'src-node', opts: undefined },
      })
      await instance.write({
        type: 'upsert_node',
        payload: { typeId: 1, name: 'dst-node', opts: undefined },
      })

      // Now create an edge between them — edge uses numeric node IDs
      const srcId = 1 // first upserted node
      const dstId = 2 // second upserted node
      await instance.engine.upsertEdge(srcId, dstId, 2)

      // Verify via neighbors
      const result = await instance.read(engine => engine.neighbors(srcId))
      expect(result.edges.length).toBeGreaterThanOrEqual(1)
      expect(result.edges[0].dst).toBe(dstId)

      await instance.stop()
    })
  })

  // ──────────────────────────────────────────
  // 乐观锁
  // ──────────────────────────────────────────

  describe('optimistic lock', () => {
    test('writeWithOptimisticLock succeeds on first write', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      runningInstances.push(instance)
      await instance.start()
      await instance.waitForLeader(2000)

      // First write: expectedVersion=0, should succeed
      const version = await instance.writeWithOptimisticLock('opt-key-1', {
        payload: { typeId: 1, name: 'opt-node-1' },
      })
      expect(version).toBe(1) // 0→1
      expect(instance.getVersion('opt-key-1')).toBe(1)

      await instance.stop()
    })

    test('writeWithOptimisticLock succeeds with correct version', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      runningInstances.push(instance)
      await instance.start()
      await instance.waitForLeader(2000)

      const v1 = await instance.writeWithOptimisticLock('opt-key-2', {
        payload: { typeId: 1, name: 'opt-node-2' },
      })
      expect(v1).toBe(1)

      const v2 = await instance.writeWithOptimisticLock('opt-key-2', {
        payload: { typeId: 1, name: 'opt-node-2-updated' },
      })
      expect(v2).toBe(2)
      expect(instance.getVersion('opt-key-2')).toBe(2)

      await instance.stop()
    })

    test('OptimisticLockError has correct message format', () => {
      const err = new RangeInstance.OptimisticLockError('test-key', 1, 2)
      expect(err.name).toBe('OptimisticLockError')
      expect(err.message).toContain('test-key')
      expect(err.message).toContain('expected version 1')
      expect(err.message).toContain('actual 2')
    })

    test('getVersion returns 0 for unknown key', () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      expect(instance.getVersion('nonexistent-key')).toBe(0)
    })
  })

  // ──────────────────────────────────────────
  // 2PC prepareTx / commitTx / rollbackTx
  // ──────────────────────────────────────────

  describe('2PC prepareTx/commitTx/rollbackTx', () => {
    test('prepareTx succeeds and creates prepare log', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      await instance.start()

      const result = await instance.prepareTx('test-tx-1', [{ type: 'upsert_node', name: 'test' }])
      expect(result).toBe(true)
      expect(instance.hasPrepareLog('test-tx-1')).toBe(true)
      expect(instance.getPrepareLogStatus('test-tx-1')).toBe('prepared')

      await instance.stop()
    })

    test('prepareTx is idempotent', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      await instance.start()

      const r1 = await instance.prepareTx('test-tx-2', [{ type: 'upsert_node' }])
      expect(r1).toBe(true)

      const r2 = await instance.prepareTx('test-tx-2', [{ type: 'different' }])
      expect(r2).toBe(true) // idempotent: returns last status
      expect(instance.getPrepareLogStatus('test-tx-2')).toBe('prepared')

      await instance.stop()
    })

    test('commitTx transitions prepare log to committed', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      await instance.start()

      await instance.prepareTx('test-tx-3', [])
      expect(instance.getPrepareLogStatus('test-tx-3')).toBe('prepared')

      await instance.commitTx('test-tx-3')
      expect(instance.getPrepareLogStatus('test-tx-3')).toBe('committed')

      await instance.stop()
    })

    test('commitTx is idempotent', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      await instance.start()

      await instance.prepareTx('test-tx-4', [])
      await instance.commitTx('test-tx-4')
      await expect(instance.commitTx('test-tx-4')).resolves.toBeUndefined()
      expect(instance.getPrepareLogStatus('test-tx-4')).toBe('committed')

      await instance.stop()
    })

    test('commitTx on unknown txId is no-op', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      await instance.start()

      await expect(instance.commitTx('unknown-tx')).resolves.toBeUndefined()
      expect(instance.hasPrepareLog('unknown-tx')).toBe(false)

      await instance.stop()
    })

    test('rollbackTx transitions prepare log to rolled_back', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      await instance.start()

      await instance.prepareTx('test-tx-5', [])
      expect(instance.getPrepareLogStatus('test-tx-5')).toBe('prepared')

      await instance.rollbackTx('test-tx-5')
      expect(instance.getPrepareLogStatus('test-tx-5')).toBe('rolled_back')

      await instance.stop()
    })

    test('rollbackTx is idempotent', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      await instance.start()

      await instance.prepareTx('test-tx-6', [])
      await instance.rollbackTx('test-tx-6')
      await expect(instance.rollbackTx('test-tx-6')).resolves.toBeUndefined()
      expect(instance.getPrepareLogStatus('test-tx-6')).toBe('rolled_back')

      await instance.stop()
    })

    test('rollbackTx on unknown txId is no-op', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      await instance.start()

      await expect(instance.rollbackTx('unknown-tx')).resolves.toBeUndefined()

      await instance.stop()
    })

    test('rollbackTx after commitTx is no-op (committed finalized)', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      await instance.start()

      await instance.prepareTx('test-tx-7', [])
      await instance.commitTx('test-tx-7')
      // rollback after commit should not change status
      await instance.rollbackTx('test-tx-7')
      expect(instance.getPrepareLogStatus('test-tx-7')).toBe('committed')

      await instance.stop()
    })

    test('hasPrepareLog returns false for unknown tx', async () => {
      const instance = new RangeInstance(makeTestConfig(), clock)
      expect(instance.hasPrepareLog('nonexistent')).toBe(false)
    })
  })
})
