/**
 * simulated-raft.spec.ts
 *
 * 测试 SimulatedRaft 相关类：
 * - RaftCore 基本生命周期（创建、启动、停止）
 * - 使用 fake timers 模拟Election timeout
 * - Leader 选举场景
 * - SimulatedRaftInstanceManager
 *
 * 每个测试独立 setUp/tearDown，使用 fs.rmSync 清理临时 WAL。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'

// We need RaftCore, SimulatedRaftInstanceManager, SimulatedRaftConsensus
import {
  SimulatedRaftInstanceManager,
  SimulatedRaftConsensus,
} from './simulated-raft'
import { RaftCore, RaftCoreConfig } from './raft-core'
import { MockTransport } from './transport'

/** 生成临时 WAL 目录路径 */
function randomWALPath(): string {
  const dir = path.join(
    os.tmpdir(),
    `raft-test-${crypto.randomBytes(4).readUInt32LE(0).toString(16)}`,
  )
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'wal.bin')
}

/** 清理 WAL 目录 */
function cleanWAL(walPath: string): void {
  const dir = path.dirname(walPath)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

describe('RaftCore (SimulatedRaftConsensus) — Lifecycle', () => {
  let walPath: string
  let core: RaftCore

  beforeEach(() => {
    walPath = randomWALPath()
  })

  afterEach(async () => {
    if (core) {
      await core.stop().catch(() => {})
    }
    cleanWAL(walPath)
  })

  it('should create RaftCore instance', () => {
    core = new RaftCore({
      nodeId: 'node-1',
      peers: [],
      walPath,
    })

    expect(core).toBeInstanceOf(RaftCore)
    expect(core.role).toBe('follower')
    expect(core.currentTerm).toBe(0)
    expect(core.isStarted).toBe(false)
  })

  it('should start and become leader without peers', async () => {
    core = new RaftCore({
      nodeId: 'single',
      peers: [],
      walPath,
    })

    await core.start()

    expect(core.isStarted).toBe(true)
    // Single-node cluster: becomes leader immediately
    expect(core.role).toBe('leader')
    expect(core.currentTerm).toBe(0)

    await core.stop()
    expect(core.isStarted).toBe(false)
    expect(core.role).toBe('follower')
  })

  it('should propose and return ok when leader', async () => {
    core = new RaftCore({
      nodeId: 'single',
      peers: [],
      walPath,
    })
    await core.start()
    expect(core.role).toBe('leader')

    const result = await core.propose(Buffer.from('test data'))
    expect(result.ok).toBe(true)
  })

  it('should fail propose when not leader', async () => {
    core = new RaftCore({
      nodeId: 'follower-node',
      peers: ['peer-1'],
      walPath,
    })
    await core.start()

    // With peers and no election, role is follower
    // Ensure at least we're not leader
    const result = await core.propose(Buffer.from('should fail'))
    // Follower should reject proposals
    expect(result.ok).toBe(false)
  })

  it('should allow double start/stop without error', async () => {
    core = new RaftCore({
      nodeId: 'resilient',
      peers: [],
      walPath,
    })

    await core.start()
    await core.start() // second start should be no-op
    expect(core.isStarted).toBe(true)

    await core.stop()
    await core.stop() // second stop should be safe
    expect(core.isStarted).toBe(false)
  })

  it('should return getNodeId and getTerm correctly', () => {
    core = new RaftCore({
      nodeId: 'my-node',
      peers: [],
      walPath,
    })

    expect(core.getNodeId()).toBe('my-node')
    expect(core.getTerm()).toBe(0)
    expect(core.getLeaderId()).toBeNull()
  })
})

describe('RaftCore — Leader Election (controlled TimerProvider)', () => {
  let walPath1: string
  let walPath2: string
  let core1: RaftCore
  let core2: RaftCore
  let timeoutFns1: Array<() => void>
  let intervalFns1: Array<() => void>
  let timeoutFns2: Array<() => void>
  let intervalFns2: Array<() => void>
  let timeoutCbId: number

  /** 创建一个可控的 TimerProvider */
  function makeTimerController(): {
    provider: import('./raft-core').TimerProvider
    timeouts: Array<() => void>
    intervals: Array<() => void>
  } {
    const timeouts: Array<() => void> = []
    const intervals: Array<() => void> = []

    const provider = {
      setTimeout: (cb: () => void, _ms: number): number => {
        timeouts.push(cb)
        return ++timeoutCbId
      },
      clearTimeout: (_id: number): void => {
        const idx = timeouts.findIndex(() => true)
        if (idx >= 0) timeouts.splice(idx, 1)
      },
      setInterval: (cb: () => void, _ms: number): number => {
        intervals.push(cb)
        return ++timeoutCbId
      },
      clearInterval: (_id: number): void => {
        const idx = intervals.findIndex(() => true)
        if (idx >= 0) intervals.splice(idx, 1)
      },
    }

    return { provider, timeouts, intervals }
  }

  beforeEach(() => {
    timeoutCbId = 0
    walPath1 = randomWALPath()
    walPath2 = randomWALPath()
  })

  afterEach(async () => {
    if (core1) {
      await core1.stop().catch(() => {})
    }
    if (core2) {
      await core2.stop().catch(() => {})
    }
    cleanWAL(walPath1)
    cleanWAL(walPath2)
  })

  it('should elect a leader in 2-node cluster (follower becomes candidate)', async () => {
    const c1 = makeTimerController()
    const c2 = makeTimerController()
    timeoutFns1 = c1.timeouts
    intervalFns1 = c1.intervals
    timeoutFns2 = c2.timeouts
    intervalFns2 = c2.intervals

    core1 = new RaftCore(
      {
        nodeId: 'node-1',
        peers: ['node-2'],
        electionTimeoutMs: 200,
        heartbeatIntervalMs: 50,
        walPath: walPath1,
      },
      undefined,
      c1.provider,
    )

    core2 = new RaftCore(
      {
        nodeId: 'node-2',
        peers: ['node-1'],
        electionTimeoutMs: 200,
        heartbeatIntervalMs: 50,
        walPath: walPath2,
      },
      undefined,
      c2.provider,
    )

    await core1.start()
    await core2.start()

    // Both start as followers
    expect(core1.role).toBe('follower')
    expect(core2.role).toBe('follower')

    // Fire the election timeout on one node — trigger election
    // core1's election timeout should fire first
    // Simulate election: manually trigger election
    await (core1 as any)._startElection()

    // After election, core1 should be leader (only 2 nodes, votes itself)
    expect(core1.role).toBe('leader')
    expect(core1.currentTerm).toBeGreaterThanOrEqual(1)
  })

  it('should not have leader before election timeout', async () => {
    const c1 = makeTimerController()
    const c2 = makeTimerController()

    core1 = new RaftCore(
      {
        nodeId: 'node-1',
        peers: ['node-2'],
        electionTimeoutMs: 500,
        heartbeatIntervalMs: 100,
        walPath: walPath1,
      },
      undefined,
      c1.provider,
    )

    core2 = new RaftCore(
      {
        nodeId: 'node-2',
        peers: ['node-1'],
        electionTimeoutMs: 500,
        heartbeatIntervalMs: 100,
        walPath: walPath2,
      },
      undefined,
      c2.provider,
    )

    await core1.start()
    await core2.start()

    // Before timeout, no one should be leader (timeout callbacks haven't been invoked)
    expect(core1.role).toBe('follower')
    expect(core2.role).toBe('follower')
  })
})

describe('RaftCore — Log replication with MockTransport', () => {
  let walPathL: string
  let walPathF: string
  let leader: RaftCore
  let follower: RaftCore
  let transport1: MockTransport
  let transport2: MockTransport

  beforeEach(() => {
    walPathL = randomWALPath()
    walPathF = randomWALPath()
    transport1 = new MockTransport('leader-1')
    transport2 = new MockTransport('follower-1')
  })

  afterEach(async () => {
    if (leader) await leader.stop().catch(() => {})
    if (follower) await follower.stop().catch(() => {})
    cleanWAL(walPathL)
    cleanWAL(walPathF)
  })

  it('should replicate log entries from leader to follower via MockTransport', async () => {
    leader = new RaftCore(
      {
        nodeId: 'leader-1',
        peers: ['follower-1'],
        electionTimeoutMs: 500,
        heartbeatIntervalMs: 100,
        walPath: walPathL,
      },
      transport1,
    )

    follower = new RaftCore(
      {
        nodeId: 'follower-1',
        peers: ['leader-1'],
        electionTimeoutMs: 500,
        heartbeatIntervalMs: 100,
        walPath: walPathF,
      },
      transport2,
    )

    await follower.start()
    await leader.start()

    // Manually trigger election on leader-1 to make it a leader
    await (leader as any)._startElection()

    // leader-1 should become leader of the 2-node cluster
    if (leader.role !== 'leader') {
      // try once more
      await (leader as any)._startElection()
    }

    expect(leader.role).toBe('leader')

    // Propose an entry from the leader
    const result = await leader.propose(Buffer.from('hello follower'))
    expect(result.ok).toBe(true)
  }, 15000)
})

describe('SimulatedRaftInstanceManager', () => {
  let manager: SimulatedRaftInstanceManager
  let walPaths: string[] = []

  beforeEach(() => {
    manager = new SimulatedRaftInstanceManager()
    walPaths = []
  })

  afterEach(() => {
    manager.clear()
    for (const wp of walPaths) {
      cleanWAL(wp)
    }
  })

  it('should register and retrieve instances', () => {
    const wp = randomWALPath()
    walPaths.push(wp)
    const r1 = new RaftCore({ nodeId: 'r1', peers: [], walPath: wp })
    manager.register('r1', r1)

    expect(manager.get('r1')).toBe(r1)
    expect(manager.size).toBe(1)
  })

  it('should unregister instances', () => {
    const wp = randomWALPath()
    walPaths.push(wp)
    const r1 = new RaftCore({ nodeId: 'r1', peers: [], walPath: wp })
    manager.register('r1', r1)
    expect(manager.size).toBe(1)

    manager.unregister('r1')
    expect(manager.get('r1')).toBeUndefined()
    expect(manager.size).toBe(0)
  })

  it('should clear all instances', () => {
    const wp1 = randomWALPath()
    const wp2 = randomWALPath()
    walPaths.push(wp1, wp2)
    const r1 = new RaftCore({ nodeId: 'r1', peers: [], walPath: wp1 })
    const r2 = new RaftCore({ nodeId: 'r2', peers: [], walPath: wp2 })
    manager.register('r1', r1)
    manager.register('r2', r2)
    expect(manager.size).toBe(2)

    manager.clear()
    expect(manager.size).toBe(0)
  })

  it('should be iterable', () => {
    const wp1 = randomWALPath()
    const wp2 = randomWALPath()
    walPaths.push(wp1, wp2)
    const r1 = new RaftCore({ nodeId: 'r1', peers: [], walPath: wp1 })
    const r2 = new RaftCore({ nodeId: 'r2', peers: [], walPath: wp2 })
    manager.register('r1', r1)
    manager.register('r2', r2)

    const ids: string[] = []
    for (const [id] of manager) {
      ids.push(id)
    }
    expect(ids.sort()).toEqual(['r1', 'r2'])
  })

  it('defaultManager should be global singleton', () => {
    expect(SimulatedRaftInstanceManager.defaultManager).toBeInstanceOf(
      SimulatedRaftInstanceManager,
    )
    expect(SimulatedRaftInstanceManager.defaultManager).toBe(
      SimulatedRaftInstanceManager.defaultManager,
    )
  })

  it('should support static reset of defaultManager', () => {
    const wp = randomWALPath()
    walPaths.push(wp)
    const r = new RaftCore({ nodeId: 'x', peers: [], walPath: wp })
    SimulatedRaftInstanceManager.defaultManager.register('x', r)
    expect(SimulatedRaftInstanceManager.defaultManager.size).toBe(1)

    SimulatedRaftInstanceManager.reset()
    expect(SimulatedRaftInstanceManager.defaultManager.size).toBe(0)
  })
})

describe('SimulatedRaftConsensus (RaftCore alias)', () => {
  let walPath: string
  let instance: SimulatedRaftConsensus

  beforeEach(() => {
    walPath = randomWALPath()
  })

  afterEach(async () => {
    if (instance) {
      await instance.stop().catch(() => {})
    }
    cleanWAL(walPath)
  })

  it('should create a RaftCore via alias', () => {
    instance = new SimulatedRaftConsensus({
      nodeId: 'alias-node',
      peers: [],
      walPath,
    })
    expect(instance).toBeInstanceOf(RaftCore)
    expect(instance.getNodeId()).toBe('alias-node')
  })

  it('should start and stop via alias', async () => {
    instance = new SimulatedRaftConsensus({
      nodeId: 'alias-test',
      peers: [],
      walPath,
    })

    await instance.start()
    expect(instance.isStarted).toBe(true)

    await instance.stop()
    expect(instance.isStarted).toBe(false)
  })
})
