/**
 * AC-FI-2: 模拟节点宕机
 *
 * 1. 创建 3 节点集群
 * 2. 停止一个节点（模拟宕机）
 * 3. 验证剩余节点继续工作（quorum 保持）
 * 4. 重启宕机节点
 * 5. 验证恢复后集群功能
 */
import { GraphEngine } from '../../src/core/graph-engine'
import { RaftNode } from '../../src/consensus/raft-node'
import { HlcClock } from '../../src/replication/hlc-clock'
import { SimulatedRaftConsensus } from '../../src/consensus/simulated-raft'
import { OverGraphConfig, RaftNodeConfig } from '../../src/types'
import * as fs from 'fs'
import * as path from 'path'

describe('AC-FI-2: 模拟节点宕机', () => {
  const node1Dir = path.join('/tmp', `agentiX-fault-crash-1-${Date.now()}`)
  const node2Dir = path.join('/tmp', `agentiX-fault-crash-2-${Date.now()}`)
  const node3Dir = path.join('/tmp', `agentiX-fault-crash-3-${Date.now()}`)
  const node1Id = 'crash-node-1'
  const node2Id = 'crash-node-2'
  const node3Id = 'crash-node-3'

  let raft1: RaftNode
  let raft2: RaftNode
  let raft3: RaftNode
  let nodes: RaftNode[]

  beforeAll(async () => {
    SimulatedRaftConsensus.reset()
    process.env.CONSENSUS_MODE = 'simulated-raft'

    for (const dir of [node1Dir, node2Dir, node3Dir]) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const peerIds = [node1Id, node2Id, node3Id]
    const peerConfigs = peerIds.map(id => ({ id, address: `memory://${id}` }))

    function createRaftNode(nodeId: string, dataDir: string): RaftNode {
      const config: OverGraphConfig = { path: dataDir }
      const engine = new GraphEngine(config)
      const clock = new HlcClock()
      const raftConfig: RaftNodeConfig = {
        nodeId,
        peers: peerConfigs,
        storagePath: dataDir,
        electionTimeoutMinMs: 200,
        electionTimeoutMaxMs: 400,
        heartbeatIntervalMs: 50,
      }
      return new RaftNode(raftConfig, engine, clock)
    }

    raft1 = createRaftNode(node1Id, node1Dir)
    raft2 = createRaftNode(node2Id, node2Dir)
    raft3 = createRaftNode(node3Id, node3Dir)
    nodes = [raft1, raft2, raft3]

    await raft1.start()
    await raft2.start()
    await raft3.start()
    await raft1.waitForLeader(5000)
  }, 30000)

  afterAll(async () => {
    for (const n of nodes) { await n.stop() }
    for (const dir of [node1Dir, node2Dir, node3Dir]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    SimulatedRaftConsensus.reset()
  }, 10000)

  it('1. 3 节点集群运行正常', () => {
    const leaderCount = nodes.filter(n => n.getStatus().role === 'leader').length
    expect(leaderCount).toBe(1)
  })

  it('2. 模拟一个节点宕机，剩余节点继续工作', async () => {
    const leaderNode = nodes.find(n => n.getStatus().role === 'leader')!
    expect(leaderNode).toBeDefined()

    // 停掉一个非 Leader 节点模拟宕机
    const crashNode = nodes.find(n => n.getStatus().role !== 'leader')!
    expect(crashNode).toBeDefined()

    await crashNode.stop()

    // 验证 Leader 节点仍然可以写入（quorum 保持：3 节点中 1 个宕机，尚存 2 ≥ 2）
    const nodeName = `CrashWrite-${Date.now()}`
    await leaderNode.write({
      type: 'upsert_node',
      payload: { typeId: 1, name: nodeName },
    })

    // Leader 状态应保持不变
    expect(leaderNode.getStatus().role).toBe('leader')
  })

  it('3. 重启宕机节点', async () => {
    // 找到已停止的节点
    const crashedNode = nodes.find(n => !n.isStarted)
    if (!crashedNode) return

    await crashedNode.start()

    // 重启后角色应有效
    const status = crashedNode.getStatus()
    expect(status.role).toBeDefined()
    expect(status.leaderId).not.toBeNull()
  })

  it('4. 重启后集群可继续写入', async () => {
    const leaderNode = nodes.find(n => n.getStatus().role === 'leader')!
    expect(leaderNode).toBeDefined()

    // 所有节点都启动后写入
    const nodeName = `RecoveredWrite-${Date.now()}`
    await leaderNode.write({
      type: 'upsert_node',
      payload: { typeId: 1, name: nodeName },
    })

    // 验证 Leader 状态
    const status = leaderNode.getStatus()
    expect(status.role).toBe('leader')
  })
})
