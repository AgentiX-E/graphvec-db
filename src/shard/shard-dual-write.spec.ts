/**
 * shard-dual-write.spec.ts — Reshard 双写机制测试
 *
 * 验证 ShardManager 的双写机制：
 * 1. 正常写入只流向源 Range
 * 2. 启用双写后，写入同时流向源 Range 和目标 Range
 * 3. 停用双写后，写入只流向源 Range
 * 4. 目标写入失败不影响源写入
 */
import { ShardManager } from './shard-manager'
import { HlcClock } from '../replication/hlc-clock'
import { ShardMap, ReshardSplit } from '../types'
import * as fs from 'fs'

const randomId = Math.random().toString(36).slice(2, 8)
const TEST_DIR = `/tmp/agentiX-test-dual-write-${randomId}`

describe('ShardManager Dual Write', () => {
  let clock: HlcClock
  let shardMap: ShardMap
  let testRunId: string
  let mgr: ShardManager

  beforeAll(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true })
  })

  afterAll(() => {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
  })

  beforeEach(async () => {
    clock = new HlcClock()
    testRunId = Math.random().toString(36).slice(2, 8)
    shardMap = {
      version: 1,
      ranges: [
        {
          rangeId: 'source-range',
          dataDir: `${TEST_DIR}/${testRunId}/source-range`,
          raftConfig: {
            nodeId: 'source-range',
            peers: [],
            storagePath: `${TEST_DIR}/${testRunId}/source-range/raft`,
            electionTimeoutMinMs: 150,
            heartbeatIntervalMs: 50,
          },
          overgraphConfig: { path: `${TEST_DIR}/${testRunId}/source-range/graph` },
        },
      ],
      hashRing: {
        virtualNodes: 160,
        nodes: [
          { hash: '0x00000000', rangeId: 'source-range' },
        ],
      },
    }

    fs.mkdirSync(`${TEST_DIR}/${testRunId}/source-range/raft`, { recursive: true })
    fs.mkdirSync(`${TEST_DIR}/${testRunId}/source-range/graph`, { recursive: true })

    mgr = new ShardManager(shardMap, clock)
    await mgr.start()
  })

  afterEach(async () => {
    try { await mgr.stop() } catch {}
    try { fs.rmSync(`${TEST_DIR}/${testRunId}`, { recursive: true, force: true }) } catch {}
  })

  describe('dual write mechanism', () => {
    test('should write only to source range when dual write is disabled', async () => {
      // Write 5 nodes before enabling dual write
      const ids: number[] = []
      for (let i = 0; i < 5; i++) {
        const id = await mgr.upsertNode(1, `pre-dual-${i}-${testRunId}`)
        ids.push(id)
      }

      // Verify all 5 nodes exist in the source range
      const sourceRange = mgr.getRange('source-range')
      for (const id of ids) {
        const node = await sourceRange.read(engine => engine.getNode(id))
        expect(node).not.toBeNull()
      }
    })

    test('should write to both source and target during dual write', async () => {
      // Create target range (simulating what ReshardManager._startDualWrite does)
      const { RangeInstance } = await import('./range-instance')
      const targetRangeConfig = {
        rangeId: 'target-range',
        dataDir: `${TEST_DIR}/${testRunId}/target-range`,
        raftConfig: {
          nodeId: 'target-range',
          peers: [],
          storagePath: `${TEST_DIR}/${testRunId}/target-range/raft`,
          electionTimeoutMinMs: 150,
          heartbeatIntervalMs: 50,
        },
        overgraphConfig: { path: `${TEST_DIR}/${testRunId}/target-range/graph` },
      }
      fs.mkdirSync(`${TEST_DIR}/${testRunId}/target-range/raft`, { recursive: true })
      fs.mkdirSync(`${TEST_DIR}/${testRunId}/target-range/graph`, { recursive: true })

      const targetInstance = new RangeInstance(targetRangeConfig, clock)
      await targetInstance.start()
      mgr.addRange('target-range', targetInstance)

      // Step 1: Write 5 nodes before enabling dual write
      const firstBatchIds: number[] = []
      for (let i = 0; i < 5; i++) {
        const id = await mgr.upsertNode(1, `pre-dual-${i}-${testRunId}`)
        firstBatchIds.push(id)
      }

      // Enable dual write
      const splits: ReshardSplit[] = [{
        sourceRangeId: 'source-range',
        targetRangeId: 'target-range',
        hashRangeStart: 0,
        hashRangeEnd: 2147483647,
        targetNodeId: 'node-target',
        targetDataDir: `${TEST_DIR}/${testRunId}/target-range`,
      }]
      mgr.enableDualWrite(splits)

      // Step 2: Write 3 more nodes during dual write
      const secondBatchIds: number[] = []
      for (let i = 0; i < 3; i++) {
        const id = await mgr.upsertNode(1, `during-dual-${i}-${testRunId}`)
        secondBatchIds.push(id)
      }

      // Verify source range has ALL 8 nodes (getNode by ID works on source)
      const sourceRange = mgr.getRange('source-range')
      const allIds = [...firstBatchIds, ...secondBatchIds]
      for (const id of allIds) {
        const sourceNode = await sourceRange.read(engine => engine.getNode(id))
        expect(sourceNode).not.toBeNull()
      }

      // Verify target range has the 3 nodes written during dual write.
      // NOTE: Each RangeInstance has its own auto-incrementing IDs, so IDs
      // from different ranges are NOT interchangeable. Verify by checking
      // the total node count and names via engine query.
      const targetRange = mgr.getRange('target-range')
      const sourceAllNodes: Array<{ id: number; name: string }> = []
      for (let i = 0; i < 5; i++) {
        const node = await sourceRange.read(engine => engine.getNode(firstBatchIds[i]))
        if (node) sourceAllNodes.push({ id: firstBatchIds[i], name: node.name })
      }
      for (let i = 0; i < 3; i++) {
        const node = await sourceRange.read(engine => engine.getNode(secondBatchIds[i]))
        if (node) sourceAllNodes.push({ id: secondBatchIds[i], name: node.name })
      }

      // Target should have nodes with the same names as the dual-written batch
      for (let i = 0; i < 3; i++) {
        const name = `during-dual-${i}-${testRunId}`
        const targetNodes = await targetRange.read(engine => engine.findNodesByType(1))
        const matched = targetNodes.some((tid: number) => {
          const node = targetRange.read(engine => engine.getNode(tid))
          // Can't do nested awaits in a sync some() — use for loop instead
          return false
        })
      }
      // Simpler: just verify source has all 8, target has > 0 nodes after dual write
      const targetNodeIds = await targetRange.read(engine => engine.findNodesByType(1))
      expect(targetNodeIds.length).toBeGreaterThanOrEqual(3)

      // Verify names in target range — iterate through all target node IDs
      let dualWrittenCount = 0
      for (const tid of targetNodeIds) {
        const targetNode = await targetRange.read(engine => engine.getNode(tid))
        if (targetNode && targetNode.name.startsWith('during-dual-')) {
          dualWrittenCount++
        }
      }
      expect(dualWrittenCount).toBe(3)

      // Disable dual write
      mgr.disableDualWrite()

      // Step 3: Write 2 more nodes after disabling dual write
      const thirdBatchIds: number[] = []
      for (let i = 0; i < 2; i++) {
        const id = await mgr.upsertNode(1, `post-dual-${i}-${testRunId}`)
        thirdBatchIds.push(id)
      }

      // Verify the source range has these 2 nodes
      for (const id of thirdBatchIds) {
        const sourceNode = await mgr.getRange('source-range').read(engine => engine.getNode(id))
        expect(sourceNode).not.toBeNull()
        // Target range should NOT have these (dual write is disabled)
        const targetNode = await mgr.getRange('target-range').read(engine => engine.getNode(id))
        expect(targetNode).toBeNull()
      }
    })

    test('should handle target write failure without affecting source', async () => {
      // Create a target range
      const { RangeInstance } = await import('./range-instance')
      const targetRangeConfig = {
        rangeId: 'failing-target',
        dataDir: `${TEST_DIR}/${testRunId}/failing-target`,
        raftConfig: {
          nodeId: 'failing-target',
          peers: [],
          storagePath: `${TEST_DIR}/${testRunId}/failing-target/raft`,
          electionTimeoutMinMs: 150,
          heartbeatIntervalMs: 50,
        },
        overgraphConfig: { path: `${TEST_DIR}/${testRunId}/failing-target/graph` },
      }
      fs.mkdirSync(`${TEST_DIR}/${testRunId}/failing-target/raft`, { recursive: true })
      fs.mkdirSync(`${TEST_DIR}/${testRunId}/failing-target/graph`, { recursive: true })

      const targetInstance = new RangeInstance(targetRangeConfig, clock)
      await targetInstance.start()
      mgr.addRange('failing-target', targetInstance)

      // Enable dual write
      const splits: ReshardSplit[] = [{
        sourceRangeId: 'source-range',
        targetRangeId: 'failing-target',
        hashRangeStart: 0,
        hashRangeEnd: 2147483647,
        targetNodeId: 'node-failing',
        targetDataDir: `${TEST_DIR}/${testRunId}/failing-target`,
      }]
      mgr.enableDualWrite(splits)

      // Kill the target range (stop it) to simulate failure
      await targetInstance.stop()

      // Write a node — source write should succeed even though target fails
      const id = await mgr.upsertNode(1, `dual-fail-test-${testRunId}`)
      expect(id).toBeGreaterThan(0)

      // Verify source range has the node
      const sourceNode = await mgr.getRange('source-range').read(engine => engine.getNode(id))
      expect(sourceNode).not.toBeNull()

      // Clean up
      mgr.disableDualWrite()
    })

    test('should batchUpsertNodes during dual write to both ranges', async () => {
      // Create target range
      const { RangeInstance } = await import('./range-instance')
      const targetRangeConfig = {
        rangeId: 'batch-target',
        dataDir: `${TEST_DIR}/${testRunId}/batch-target`,
        raftConfig: {
          nodeId: 'batch-target',
          peers: [],
          storagePath: `${TEST_DIR}/${testRunId}/batch-target/raft`,
          electionTimeoutMinMs: 150,
          heartbeatIntervalMs: 50,
        },
        overgraphConfig: { path: `${TEST_DIR}/${testRunId}/batch-target/graph` },
      }
      fs.mkdirSync(`${TEST_DIR}/${testRunId}/batch-target/raft`, { recursive: true })
      fs.mkdirSync(`${TEST_DIR}/${testRunId}/batch-target/graph`, { recursive: true })

      const targetInstance = new RangeInstance(targetRangeConfig, clock)
      await targetInstance.start()
      mgr.addRange('batch-target', targetInstance)

      // Enable dual write
      const splits: ReshardSplit[] = [{
        sourceRangeId: 'source-range',
        targetRangeId: 'batch-target',
        hashRangeStart: 0,
        hashRangeEnd: 2147483647,
        targetNodeId: 'node-batch',
        targetDataDir: `${TEST_DIR}/${testRunId}/batch-target`,
      }]
      mgr.enableDualWrite(splits)

      // Batch upsert nodes during dual write
      const inputs = Array.from({ length: 4 }, (_, i) => ({
        typeId: 1,
        name: `batch-dual-${i}-${testRunId}`,
      }))
      const ids = await mgr.batchUpsertNodes(inputs)

      // Verify all nodes exist in both ranges
      for (let i = 0; i < ids.length; i++) {
        const sourceNode = await mgr.getRange('source-range').read(engine => engine.getNode(ids[i]))
        expect(sourceNode).not.toBeNull()
        expect(sourceNode!.name).toBe(inputs[i].name)

        const targetNode = await mgr.getRange('batch-target').read(engine => engine.getNode(ids[i]))
        expect(targetNode).not.toBeNull()
        expect(targetNode!.name).toBe(inputs[i].name)
      }

      mgr.disableDualWrite()
    })

    test('should upsertEdge dual write to both ranges', async () => {
      // Create target range
      const { RangeInstance } = await import('./range-instance')
      const targetRangeConfig = {
        rangeId: 'edge-target',
        dataDir: `${TEST_DIR}/${testRunId}/edge-target`,
        raftConfig: {
          nodeId: 'edge-target',
          peers: [],
          storagePath: `${TEST_DIR}/${testRunId}/edge-target/raft`,
          electionTimeoutMinMs: 150,
          heartbeatIntervalMs: 50,
        },
        overgraphConfig: { path: `${TEST_DIR}/${testRunId}/edge-target/graph` },
      }
      fs.mkdirSync(`${TEST_DIR}/${testRunId}/edge-target/raft`, { recursive: true })
      fs.mkdirSync(`${TEST_DIR}/${testRunId}/edge-target/graph`, { recursive: true })

      const targetInstance = new RangeInstance(targetRangeConfig, clock)
      await targetInstance.start()
      mgr.addRange('edge-target', targetInstance)

      // Create source & dst nodes
      const srcId = await mgr.upsertNode(1, `edge-src-${testRunId}`)
      const dstId = await mgr.upsertNode(2, `edge-dst-${testRunId}`)

      // Enable dual write
      const splits: ReshardSplit[] = [{
        sourceRangeId: 'source-range',
        targetRangeId: 'edge-target',
        hashRangeStart: 0,
        hashRangeEnd: 2147483647,
        targetNodeId: 'node-edge',
        targetDataDir: `${TEST_DIR}/${testRunId}/edge-target`,
      }]
      mgr.enableDualWrite(splits)

      // Write edge during dual write
      await mgr.upsertEdge(srcId, dstId, 3)

      // Verify edge exists in both ranges
      const sourceEdge = await mgr.getRange('source-range').read(engine => engine.getEdge(srcId, dstId, 3))
      expect(sourceEdge).not.toBeNull()

      const targetEdge = await mgr.getRange('edge-target').read(engine => engine.getEdge(srcId, dstId, 3))
      expect(targetEdge).not.toBeNull()

      mgr.disableDualWrite()
    })

    test('should deleteNode dual write from both ranges', async () => {
      // Create target range
      const { RangeInstance } = await import('./range-instance')
      const targetRangeConfig = {
        rangeId: 'del-target',
        dataDir: `${TEST_DIR}/${testRunId}/del-target`,
        raftConfig: {
          nodeId: 'del-target',
          peers: [],
          storagePath: `${TEST_DIR}/${testRunId}/del-target/raft`,
          electionTimeoutMinMs: 150,
          heartbeatIntervalMs: 50,
        },
        overgraphConfig: { path: `${TEST_DIR}/${testRunId}/del-target/graph` },
      }
      fs.mkdirSync(`${TEST_DIR}/${testRunId}/del-target/raft`, { recursive: true })
      fs.mkdirSync(`${TEST_DIR}/${testRunId}/del-target/graph`, { recursive: true })

      const targetInstance = new RangeInstance(targetRangeConfig, clock)
      await targetInstance.start()
      mgr.addRange('del-target', targetInstance)

      // Write a node
      const nodeId = await mgr.upsertNode(1, `delete-me-${testRunId}`)

      // Enable dual write
      const splits: ReshardSplit[] = [{
        sourceRangeId: 'source-range',
        targetRangeId: 'del-target',
        hashRangeStart: 0,
        hashRangeEnd: 2147483647,
        targetNodeId: 'node-del',
        targetDataDir: `${TEST_DIR}/${testRunId}/del-target`,
      }]
      mgr.enableDualWrite(splits)

      // Delete during dual write — should delete from both ranges
      await mgr.deleteNode(nodeId)

      // Verify node is deleted from both ranges
      const sourceNode = await mgr.getRange('source-range').read(engine => engine.getNode(nodeId))
      expect(sourceNode).toBeNull()

      const targetNode = await mgr.getRange('del-target').read(engine => engine.getNode(nodeId))
      expect(targetNode).toBeNull()

      mgr.disableDualWrite()
    })
  })
})
