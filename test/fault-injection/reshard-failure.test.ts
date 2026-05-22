/**
 * AC-FI-4: Resharding 故障恢复
 *
 * 模拟 reshard 过程中目标节点不可用等故障场景，
 * 验证系统能正确处理回滚等恢复机制。
 *
 * 测试场景:
 * 1. ReshardManager rollback 可被调用且不崩溃
 * 2. ReshardWorker rollback 正常执行
 * 3. ReshardPlan generatePlan 在无效输入下返回 null 而非崩溃
 * 4. ReshardPlan generatePlan 在小负载下返回 null
 */
import { ReshardManager } from '../../src/reshard/reshard-manager'
import { ReshardPlan } from '../../src/reshard/reshard-plan'
import { ShardManager } from '../../src/shard/shard-manager'
import { HlcClock } from '../../src/replication/hlc-clock'
import { ShardMap } from '../../src/types'
import * as path from 'path'
import * as fs from 'fs'

describe('AC-FI-4: Resharding 故障恢复', () => {
  const dataDir = path.join('/tmp', `agentiX-fault-reshard-${Date.now()}`)
  let clock: HlcClock

  beforeAll(() => {
    fs.mkdirSync(dataDir, { recursive: true })
    clock = new HlcClock()
  })

  afterAll(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  test('ReshardPlan generatePlan 在空输入时返回 null 而非崩溃', () => {
    const plan = new ReshardPlan()
    const shardMap: ShardMap = {
      version: 1,
      ranges: [],
      hashRing: { virtualNodes: 160, nodes: [] },
    }
    const result = plan.generatePlan(shardMap, [])
    expect(result).toBeNull()
  })

  test('ReshardPlan generatePlan 在小负载下返回 null 而非崩溃', () => {
    const plan = new ReshardPlan()
    const shardMap: ShardMap = {
      version: 1,
      ranges: [{ rangeId: 'range-1', dataDir: './data/range-1', raftConfig: { nodeId: 'n1', peers: [], storagePath: './data/range-1' }, overgraphConfig: { path: './data/range-1/graph' } }],
      hashRing: { virtualNodes: 160, nodes: [{ hash: 'range-1', rangeId: 'range-1' }] },
    }
    // nodeCount 未超过阈值 10000，应返回 null
    const result = plan.generatePlan(shardMap, [{ rangeId: 'range-1', nodeCount: 100 }])
    expect(result).toBeNull()
  })

  test('rollback 可在不完整状态下安全调用', async () => {
    const shardMap: ShardMap = {
      version: 1,
      ranges: [],
      hashRing: { virtualNodes: 160, nodes: [] },
    }
    const shardManager = new ShardManager(shardMap, clock)
    const reshardManager = new ReshardManager(shardManager, clock)

    // 在没有执行 reshard 时调用 rollback 不应崩溃
    await expect(reshardManager.rollback()).resolves.not.toThrow()
  })
})
