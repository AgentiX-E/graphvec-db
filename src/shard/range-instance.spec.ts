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

  beforeAll(() => {
    fs.mkdirSync(`${TEST_DIR}/raft`, { recursive: true })
    fs.mkdirSync(`${TEST_DIR}/graph`, { recursive: true })
  })

  afterAll(() => {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
  })

  beforeEach(() => {
    clock = new HlcClock()
  })

  afterEach(() => {
    // Clean graph/raft dirs so next test gets fresh state
    try { fs.rmSync(`${TEST_DIR}/graph`, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(`${TEST_DIR}/raft`, { recursive: true, force: true }) } catch {}
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
      expect(instance.raft).toBeDefined()
      expect(instance.engine).toBeDefined()
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
      expect(instance.raft.isStarted).toBe(false)

      await instance.start()
      expect(instance.engine.isOpen).toBe(true)
      expect(instance.raft.isStarted).toBe(true)

      await instance.stop()
      expect(instance.engine.isOpen).toBe(false)
      expect(instance.raft.isStarted).toBe(false)
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
        expect(instance.raft.isStarted).toBe(true)
        await instance.stop()
        expect(instance.engine.isOpen).toBe(false)
        expect(instance.raft.isStarted).toBe(false)
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
      await instance.raft.engine_.upsertEdge(srcId, dstId, 2)

      // Verify via neighbors
      const result = await instance.read(engine => engine.neighbors(srcId))
      expect(result.edges.length).toBeGreaterThanOrEqual(1)
      expect(result.edges[0].dst).toBe(dstId)

      await instance.stop()
    })
  })
})
