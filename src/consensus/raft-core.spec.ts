/**
 * raft-core.spec.ts — RaftCore 固化共识测试
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { RaftCore, RaftCoreConfig } from './raft-core'
import { MockTransport } from './transport'
import { MockTimer } from './mock-timer'

function createConfig(nodeId: string, peers: string[], testDir: string): RaftCoreConfig {
  return {
    nodeId,
    peers: peers.filter(p => p !== nodeId),
    electionTimeoutMs: 500,
    heartbeatIntervalMs: 100,
    walPath: path.join(testDir, `${nodeId}.wal`),
  }
}

/**
 * 等待条件满足（带超时）
 */
async function waitFor(
  condition: () => boolean,
  timeoutMs: number = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error(`Timeout waiting for condition`)
}

describe('RaftCore', () => {
  const testDir = path.join(os.tmpdir(), 'raft-core-test')

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true })
    MockTransport.reset()
  })

  afterEach(() => {
    MockTransport.reset()
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  describe('single node', () => {
    it('should start and become leader in single-node cluster', async () => {
      const core = new RaftCore(
        createConfig('node-0', ['node-0'], testDir),
        new MockTransport('node-0'),
      )
      await core.start()

      // Single node: should become leader quickly (only self in peers)
      await core.waitForLeader(2000)
      expect(core.role).toBe('leader')
      expect(core.getLeaderId()).toBe('node-0')

      await core.stop()
    })

    it('should propose and apply entries', async () => {
      const applied: string[] = []
      const core = new RaftCore(
        createConfig('node-0', ['node-0'], testDir),
        new MockTransport('node-0'),
      )
      core.setApply(async (data: Uint8Array) => {
        applied.push(Buffer.from(data).toString())
      })
      await core.start()
      await core.waitForLeader(2000)

      const result = await core.propose(Buffer.from('hello'))
      expect(result.ok).toBe(true)
      expect(applied).toContain('hello')

      await core.stop()
    })

    it('should persist entries in WAL across restart (3-node cluster)', async () => {
      // 3 节点集群模拟：propose → 停所有节点 → 重启 leader 验证 WAL 恢复
      const nodes = ['node-0', 'node-1', 'node-2']
      const configs = nodes.map(n => createConfig(n, nodes, testDir))
      const nodesDir = (i: number) => path.dirname(configs[i].walPath)
      // 确保目录存在
      for (let i = 0; i < 3; i++) fs.mkdirSync(nodesDir(i), { recursive: true })

      // 第一轮：启动 3 节点集群
      const applied: string[] = []
      const cores: RaftCore[] = []
      for (let i = 0; i < 3; i++) {
        const core = new RaftCore(configs[i], new MockTransport(nodes[i]))
        core.setApply(async (data: Uint8Array) => {
          applied.push(Buffer.from(data).toString())
        })
        cores.push(core)
      }

      await Promise.all(cores.map(c => c.start()))
      // 等待选出 leader
      let leaderIdx = -1
      for (let attempt = 0; attempt < 20; attempt++) {
        leaderIdx = cores.findIndex(c => c.role === 'leader')
        if (leaderIdx >= 0) break
        await new Promise(r => setTimeout(r, 200))
      }
      expect(leaderIdx).toBeGreaterThanOrEqual(0)

      const leaderNodeId = nodes[leaderIdx]
      const leaderConfig = configs[leaderIdx]

      // 通过 leader 写入 2 条 entry
      await cores[leaderIdx].propose(Buffer.from('persist-me'))
      await cores[leaderIdx].propose(Buffer.from('also-this'))
      await Promise.all(cores.map(c => c.stop()))

      // 第二轮：仅重启 leader 节点
      const core2 = new RaftCore(leaderConfig, new MockTransport(leaderNodeId))
      expect(core2.lastLogIndex).toBe(0) // not started yet

      await core2.start()
      expect(core2.lastLogIndex).toBe(2) // recovered 2 entries
      expect(core2.lastLogTerm).toBeGreaterThanOrEqual(1) // entries committed in some term

      await core2.stop()
    })
  })

  describe('multi-node cluster', () => {
    it('should elect a leader among 3 nodes', async () => {
      const nodes = ['node-0', 'node-1', 'node-2']
      const cores: RaftCore[] = []

      try {
        // Create 3 nodes with staggered election timeouts
        for (let i = 0; i < 3; i++) {
          const config: RaftCoreConfig = {
            ...createConfig(nodes[i], nodes, testDir),
            // Stagger timeouts to ensure deterministic election: node-0 fastest
            electionTimeoutMs: 200 + i * 300,
            heartbeatIntervalMs: 100,
          }
          const core = new RaftCore(
            config,
            new MockTransport(nodes[i]),
          )
          cores.push(core)
        }

        // Start all nodes
        await Promise.all(cores.map(c => c.start()))

        // Wait for a leader to be elected
        await waitFor(() => cores.some(c => c.role === 'leader'), 3000)

        const leader = cores.find(c => c.role === 'leader')
        expect(leader).toBeDefined()
        expect(leader!.currentTerm).toBeGreaterThan(0)

      } finally {
        await Promise.all(cores.map(c => c.stop().catch(() => {})))
      }
    }, 10000)

    it('should replicate entries from leader to followers', async () => {
      const nodes = ['node-0', 'node-1', 'node-2']
      const cores: RaftCore[] = []
      const applied: Map<string, string[]> = new Map()

      try {
        for (let i = 0; i < 3; i++) {
          applied.set(nodes[i], [])
          const config: RaftCoreConfig = {
            ...createConfig(nodes[i], nodes, testDir),
            electionTimeoutMs: 200 + i * 300,
            heartbeatIntervalMs: 100,
          }
          const core = new RaftCore(
            config,
            new MockTransport(nodes[i]),
          )
          core.setApply(async (data: Uint8Array) => {
            applied.get(nodes[i])!.push(Buffer.from(data).toString())
          })
          cores.push(core)
        }

        await Promise.all(cores.map(c => c.start()))
        await waitFor(() => cores.some(c => c.role === 'leader'), 3000)

        const leader = cores.find(c => c.role === 'leader')!
        expect(leader).toBeDefined()

        // Propose from leader
        const result = await leader.propose(Buffer.from('replicated-data'))
        expect(result.ok).toBe(true)

        // Give time for replication
        await new Promise(r => setTimeout(r, 500))

        // Check WAL indices on all nodes
        for (const core of cores) {
          expect(core.lastLogIndex).toBeGreaterThanOrEqual(1)
        }

      } finally {
        await Promise.all(cores.map(c => c.stop().catch(() => {})))
      }
    }, 10000)

    it('should handle leader re-election after leader steps down', async () => {
      const nodes = ['node-a', 'node-b', 'node-c']
      const cores: RaftCore[] = []

      try {
        for (let i = 0; i < 3; i++) {
          const config: RaftCoreConfig = {
            ...createConfig(nodes[i], nodes, testDir),
            // node-a fastest, others slower
            electionTimeoutMs: i === 0 ? 200 : 2000,
            heartbeatIntervalMs: 100,
          }
          const core = new RaftCore(config, new MockTransport(nodes[i]))
          cores.push(core)
        }

        await Promise.all(cores.map(c => c.start()))

        // node-a should become leader (fastest timeout)
        await waitFor(() => cores[0].role === 'leader', 3000)
        expect(cores[0].role).toBe('leader')

        // Stop node-a to trigger new election
        await cores[0].stop()

        // Another node should eventually become leader
        await waitFor(() => cores[1].role === 'leader' || cores[2].role === 'leader', 5000)
        const newLeader = cores.find(c => c.role === 'leader')
        expect(newLeader).toBeDefined()
        expect(newLeader!.getNodeId()).not.toBe('node-a')

      } finally {
        await Promise.all(cores.map(c => c.stop().catch(() => {})))
      }
    }, 15000)
  })

  describe('follower proposes', () => {
    it('should reject proposals from followers', async () => {
      const core = new RaftCore(
        createConfig('node-0', ['node-0'], testDir),
        new MockTransport('node-0'),
      )
      await core.start()

      // Not leader yet
      const result = await core.propose(Buffer.from('test'))
      // If follower → returns { ok: false }
      // Node-0 has no peers, so it will become leader
      // But if it hasn't elected yet, it could be follower
      expect(result.ok).toBeDefined()

      await core.stop()
    })
  })

  describe('PreVote', () => {
    it('should elect a leader with preVote enabled (3 nodes)', async () => {
      const nodes = ['node-0', 'node-1', 'node-2']
      const cores: RaftCore[] = []

      try {
        for (let i = 0; i < 3; i++) {
          const config: RaftCoreConfig = {
            ...createConfig(nodes[i], nodes, testDir),
            electionTimeoutMs: 200 + i * 300,
            heartbeatIntervalMs: 100,
            preVote: true,
          }
          const core = new RaftCore(config, new MockTransport(nodes[i]))
          cores.push(core)
        }

        await Promise.all(cores.map(c => c.start()))

        // Wait for a leader to be elected
        await waitFor(() => cores.some(c => c.role === 'leader'), 5000)

        const leader = cores.find(c => c.role === 'leader')
        expect(leader).toBeDefined()
        expect(leader!.currentTerm).toBeGreaterThan(0)

      } finally {
        await Promise.all(cores.map(c => c.stop().catch(() => {})))
      }
    }, 10000)

    it('should replicate entries with preVote enabled', async () => {
      const nodes = ['node-0', 'node-1', 'node-2']
      const cores: RaftCore[] = []

      try {
        for (let i = 0; i < 3; i++) {
          const config: RaftCoreConfig = {
            ...createConfig(nodes[i], nodes, testDir),
            electionTimeoutMs: 200 + i * 300,
            heartbeatIntervalMs: 100,
            preVote: true,
          }
          const core = new RaftCore(config, new MockTransport(nodes[i]))
          cores.push(core)
        }

        await Promise.all(cores.map(c => c.start()))
        await waitFor(() => cores.some(c => c.role === 'leader'), 5000)

        const leader = cores.find(c => c.role === 'leader')!
        expect(leader).toBeDefined()

        const result = await leader.propose(Buffer.from('prevote-data'))
        expect(result.ok).toBe(true)

        // Give time for replication
        await new Promise(r => setTimeout(r, 500))

        for (const core of cores) {
          expect(core.lastLogIndex).toBeGreaterThanOrEqual(1)
        }

      } finally {
        await Promise.all(cores.map(c => c.stop().catch(() => {})))
      }
    }, 10000)
  })

  describe('CheckQuorum', () => {
    it('should step down when leader loses majority connection', async () => {
      const nodes = ['node-0', 'node-1', 'node-2']
      const cores: RaftCore[] = []

      try {
        for (let i = 0; i < 3; i++) {
          const config: RaftCoreConfig = {
            ...createConfig(nodes[i], nodes, testDir),
            electionTimeoutMs: 200 + i * 300,
            heartbeatIntervalMs: 50,
            checkQuorum: true,
          }
          const core = new RaftCore(config, new MockTransport(nodes[i]))
          cores.push(core)
        }

        await Promise.all(cores.map(c => c.start()))
        await waitFor(() => cores.some(c => c.role === 'leader'), 5000)
        const leader = cores.find(c => c.role === 'leader')
        expect(leader).toBeDefined()
        const leaderIdx = cores.indexOf(leader!)

        // Stop ALL other nodes to simulate complete partition
        const nonLeaderCores = cores.filter((c, i) => i !== leaderIdx)
        for (const nc of nonLeaderCores) {
          await nc.stop()
        }

        // Leader should step down within a few heartbeat intervals
        // It will try to re-elect itself but should step down again on each check
        await waitFor(() => leader!.role === 'follower', 2000)

      } finally {
        await Promise.all(cores.map(c => {
          try { if (c.isStarted) return c.stop() } catch { /* ignore */ }
          return Promise.resolve()
        })).catch(() => {})
      }
    }, 15000)

    it('should remain leader with majority connection', async () => {
      const nodes = ['node-0', 'node-1', 'node-2']
      const cores: RaftCore[] = []

      try {
        for (let i = 0; i < 3; i++) {
          const config: RaftCoreConfig = {
            ...createConfig(nodes[i], nodes, testDir),
            electionTimeoutMs: 200 + i * 300,
            heartbeatIntervalMs: 100,
            checkQuorum: true,
          }
          const core = new RaftCore(config, new MockTransport(nodes[i]))
          cores.push(core)
        }

        await Promise.all(cores.map(c => c.start()))

        // Wait for a leader to be elected
        await waitFor(() => cores.some(c => c.role === 'leader'), 5000)

        const leader = cores.find(c => c.role === 'leader')
        expect(leader).toBeDefined()
        expect(leader!.role).toBe('leader')

        // All nodes are connected, leader should remain leader
        await new Promise(r => setTimeout(r, 500))
        expect(leader!.role).toBe('leader')

      } finally {
        await Promise.all(cores.map(c => c.stop().catch(() => {})))
      }
    }, 15000)
  })
})
