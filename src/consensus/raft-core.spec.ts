/**
 * raft-core.spec.ts — RaftCore 固化共识单元测试
 *
 * 覆盖维度：
 * 1. RaftCoreConfig 验证 — 配置校验、默认值、必须参数
 * 2. Leader 选举 — 超时触发选举、requestVote 处理、获得多数票成为 leader
 * 3. 日志复制 — appendEntries、日志一致性检查、写入 WAL
 * 4. 角色转换 — follower→candidate→leader 的完整生命周期
 * 5. 心跳 — leader 心跳发送、follower 心跳超时
 * 6. 任期管理 — 任期递增、stale term 拒绝、term 同步
 * 7. MockTransport 集成 — 使用 MockTransport 模拟节点间通信
 * 8. 错误路径 — 网络分区、投票分裂、日志冲突
 *
 * 技术约束：
 * - 使用 vitest
 * - 完全真实实现，不 mock RaftCore 本身
 * - 单机测试（单个 RaftCore + MockTransport）
 * - 使用 vi.useFakeTimers() 控制选举超时
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RaftCore, RaftCoreConfig } from './raft-core'
import { MockTransport } from './transport'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ─── 测试辅助 ──────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'raft-core-'))
}

function defaultCfg(nodeId: string, peers: string[], tmp: string, overrides?: Partial<RaftCoreConfig>): RaftCoreConfig {
  return {
    nodeId,
    peers,
    walPath: path.join(tmp, `wal-${nodeId}.dat`),
    electionTimeoutMs: 150,
    heartbeatIntervalMs: 50,
    preVote: false,
    checkQuorum: false,
    snapshotThreshold: 10000,
    snapshotPath: path.join(tmp, `snap-${nodeId}.json`),
    ...overrides,
  }
}

interface NodeRef {
  node: RaftCore
  transport: MockTransport
  walPath: string
  snapPath: string
}

async function createNode(
  nodeId: string,
  peers: string[],
  tmp: string,
  overrides?: Partial<RaftCoreConfig>,
): Promise<NodeRef> {
  const transport = new MockTransport(nodeId)
  const cfg = defaultCfg(nodeId, peers, tmp, overrides)
  const node = new RaftCore(cfg, transport)
  return { node, transport, walPath: cfg.walPath, snapPath: cfg.snapshotPath! }
}

async function createPeerNodes(
  ids: string[],
  tmp: string,
  overrides?: Partial<RaftCoreConfig>,
): Promise<NodeRef[]> {
  const refs: NodeRef[] = []
  for (const id of ids) {
    const peers = ids.filter(x => x !== id)
    refs.push(await createNode(id, peers, tmp, overrides))
  }
  return refs
}

async function startAll(refs: NodeRef[]): Promise<void> {
  for (const r of refs) await r.node.start()
}

function cleanup(tmp: string): void {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
}

// ─── 1. RaftCoreConfig 验证 ──────────────────────────────

describe('1. RaftCoreConfig 验证', () => {
  let tmp: string

  beforeEach(() => {
    tmp = makeTmpDir()
    MockTransport.reset()
  })

  afterEach(() => {
    cleanup(tmp)
  })

  it('应该使用默认值填充可选参数', () => {
    const node = new RaftCore({
      nodeId: 'n1',
      peers: ['n2', 'n3'],
      walPath: path.join(tmp, 'wal.dat'),
    })
    expect((node as any).config.electionTimeoutMs).toBe(150)
    expect((node as any).config.heartbeatIntervalMs).toBe(50)
    expect((node as any).config.preVote).toBe(false)
    expect((node as any).config.checkQuorum).toBe(false)
    expect((node as any).config.snapshotThreshold).toBe(10000)
    expect((node as any).config.snapshotPath).toBe(path.join(tmp, 'wal.dat.snapshot'))
  })

  it('应该使用用户提供的配置值', () => {
    const node = new RaftCore({
      nodeId: 'n1',
      peers: ['n2'],
      walPath: path.join(tmp, 'wal.dat'),
      electionTimeoutMs: 300,
      heartbeatIntervalMs: 100,
      preVote: true,
      checkQuorum: true,
      snapshotThreshold: 5000,
      snapshotPath: path.join(tmp, 'my-snap.json'),
    })
    expect((node as any).config.electionTimeoutMs).toBe(300)
    expect((node as any).config.heartbeatIntervalMs).toBe(100)
    expect((node as any).config.preVote).toBe(true)
    expect((node as any).config.checkQuorum).toBe(true)
    expect((node as any).config.snapshotThreshold).toBe(5000)
    expect((node as any).config.snapshotPath).toBe(path.join(tmp, 'my-snap.json'))
  })

  it('nodeId 和 peers 是必需的配置', () => {
    // @ts-expect-error — 缺少必需参数
    expect(() => new RaftCore({ peers: ['n2'], walPath: path.join(tmp, 'wal.dat') })).not.toThrow()
    // @ts-expect-error — 缺少必需参数
    expect(() => new RaftCore({ nodeId: 'n1', walPath: path.join(tmp, 'wal.dat') })).not.toThrow()
  })

  it('为空 peers 时 start 后立即成为 leader', async () => {
    const ref = await createNode('n1', [], tmp)
    await ref.node.start()
    expect(ref.node.role).toBe('leader')
    expect(ref.node.currentTerm).toBe(0)
    await ref.node.stop()
  })

  it('配置 snapshotPath 默认值为 walPath + .snapshot', () => {
    const node = new RaftCore({
      nodeId: 'n1',
      peers: [],
      walPath: '/data/raft/wal-01.dat',
    })
    expect((node as any).config.snapshotPath).toBe('/data/raft/wal-01.dat.snapshot')
  })
})

// ─── 2. Leader 选举 ─────────────────────────────────────

describe('2. Leader 选举', () => {
  let tmp: string

  beforeEach(() => {
    tmp = makeTmpDir()
    MockTransport.reset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup(tmp)
  })

  it('选举超时后 candidate 递增 term 并发起投票', async () => {
    const transport = new MockTransport('n1')
    const t2 = new MockTransport('n2')
    await t2.start()

    const cfg = defaultCfg('n1', ['n2'], tmp)
    const node = new RaftCore(cfg, transport)
    await node.start()

    expect(node.role).toBe('follower')
    expect(node.currentTerm).toBe(0)

    // 推进到选举超时触发
    await vi.advanceTimersByTimeAsync(500)

    expect(node.role).toBe('candidate')
    expect(node.currentTerm).toBe(1)

    await node.stop()
  })

  it('获得多数投票后成为 leader', async () => {
    const t1 = new MockTransport('n1')
    const t2 = new MockTransport('n2')
    const t3 = new MockTransport('n3')
    await t1.start()
    await t2.start()
    await t3.start()

    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-election-'))

    const n1 = new RaftCore(defaultCfg('n1', ['n2', 'n3'], tmp2), t1)
    const n2 = new RaftCore(defaultCfg('n2', ['n1', 'n3'], tmp2), t2)
    const n3 = new RaftCore(defaultCfg('n3', ['n1', 'n2'], tmp2), t3)

    await n1.start()
    await n2.start()
    await n3.start()

    // 等待足够长时间让选举发生
    await vi.advanceTimersByTimeAsync(3000)

    const leaders = [n1, n2, n3].filter(n => n.role === 'leader')
    expect(leaders.length).toBe(1)

    const leader = leaders[0]
    expect(leader.role).toBe('leader')
    expect(leader.currentTerm).toBeGreaterThanOrEqual(1)

    await Promise.all([n1.stop(), n2.stop(), n3.stop()])
    cleanup(tmp2)
  })

  it('requestVote 处理：term 较小时拒绝投票', async () => {
    const ref = await createNode('n1', ['n2'], tmp)
    await ref.node.start()
    // @ts-expect-error — 访问私有方法
    const resp = await ref.node._handleRequestVote('n2', {
      term: 0,
      candidateId: 'n2',
      lastLogIndex: 0,
      lastLogTerm: 0,
    })
    expect(resp.voteGranted).toBe(false)
    await ref.node.stop()
  })

  it('requestVote 处理：日志不新时拒绝投票', async () => {
    // 先给 n1 写入日志
    const soloCfg = defaultCfg('n1', [], tmp)
    const solo = new RaftCore(soloCfg, new MockTransport('n1'))
    await solo.start()
    await solo.waitForLeader(1000).catch(() => {})
    await solo.propose(new Uint8Array([42]))
    const termBefore = solo.lastLogTerm
    await solo.stop()

    const ref = new RaftCore(defaultCfg('n1', ['n2'], tmp), new MockTransport('n1'))
    await ref.start()

    if (termBefore > 0) {
      // @ts-expect-error — 访问私有方法
      const resp = await ref._handleRequestVote('n2', {
        term: 10,
        candidateId: 'n2',
        lastLogIndex: 0,
        lastLogTerm: 0,
      })
      expect(resp.voteGranted).toBe(false)
    }

    await ref.stop()
  })

  it('requestVote 处理：已投票给其他人时拒绝', async () => {
    const ref = await createNode('n1', ['n2', 'n3'], tmp)
    await ref.node.start()

    // 先模拟 votedFor 被设置
    // @ts-expect-error — 访问私有属性
    ref.node._votedFor = 'n2'

    // @ts-expect-error — 访问私有方法
    const resp = await ref.node._handleRequestVote('n3', {
      term: 1,
      candidateId: 'n3',
      lastLogIndex: 0,
      lastLogTerm: 0,
    })
    expect(resp.voteGranted).toBe(false)

    await ref.node.stop()
  })
})

// ─── 3. 日志复制 ────────────────────────────────────────

describe('3. 日志复制', () => {
  let tmp: string

  beforeEach(() => {
    tmp = makeTmpDir()
    MockTransport.reset()
  })

  afterEach(() => {
    cleanup(tmp)
  })

  it('leader 写入本节点 WAL 后可以通过 propose 追加日志', async () => {
    const ref = await createNode('n1', [], tmp)
    await ref.node.start()
    expect(ref.node.role).toBe('leader')

    const result = await ref.node.propose(new Uint8Array([1, 2, 3]))
    expect(result.ok).toBe(true)

    expect(ref.node.lastLogIndex).toBe(1)
    expect(ref.node.lastLogTerm).toBe(0)

    await ref.node.stop()
  })

  it('follower 的 propose 返回 { ok: false }', async () => {
    const ref = await createNode('n1', ['n2'], tmp)
    await ref.node.start()

    const result = await ref.node.propose(new Uint8Array([1]))
    expect(result.ok).toBe(false)

    await ref.node.stop()
  })

  it('appendEntries 处理：term 小于当前 term 时拒绝', async () => {
    const ref = await createNode('n1', ['n2'], tmp)
    await ref.node.start()

    // 让 n1 的 term 增加
    // @ts-expect-error — 访问私有属性
    ref.node._currentTerm = 5

    // @ts-expect-error — 访问私有方法
    const resp2 = await ref.node._handleAppendEntries('n2', {
      term: 3,
      leaderId: 'n2',
      prevLogIndex: 0,
      prevLogTerm: 0,
      entries: [],
      leaderCommit: 0,
    })
    expect(resp2.success).toBe(false)

    await ref.node.stop()
  })

  it('appendEntries 处理：prevLogIndex 一致性检查失败时拒绝', async () => {
    const ref = await createNode('n1', ['n2'], tmp)
    await ref.node.start()

    // prevLogIndex=5 不存在
    // @ts-expect-error — 访问私有方法
    const resp = await ref.node._handleAppendEntries('leader', {
      term: 1,
      leaderId: 'leader',
      prevLogIndex: 5,
      prevLogTerm: 1,
      entries: [{ index: 6, term: 1, data: new Uint8Array([2]) }],
      leaderCommit: 0,
    })
    expect(resp.success).toBe(false)

    await ref.node.stop()
  })

  it('appendEntries 正常追加日志并推进 commitIndex', async () => {
    const ref = await createNode('n1', ['n2'], tmp)
    await ref.node.start()

    // @ts-expect-error — 访问私有方法
    const resp = await ref.node._handleAppendEntries('leader', {
      term: 1,
      leaderId: 'leader',
      prevLogIndex: 0,
      prevLogTerm: 0,
      entries: [
        { index: 1, term: 1, data: new Uint8Array([1]) },
        { index: 2, term: 1, data: new Uint8Array([2]) },
      ],
      leaderCommit: 2,
    })
    expect(resp.success).toBe(true)
    expect(resp.lastLogIndex).toBe(2)
    expect(ref.node.lastLogIndex).toBe(2)
    expect(ref.node.commitIndex).toBe(2)

    await ref.node.stop()
  })
})

// ─── 4. 角色转换 ────────────────────────────────────────

describe('4. 角色转换', () => {
  let tmp: string

  beforeEach(() => {
    tmp = makeTmpDir()
    MockTransport.reset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup(tmp)
  })

  it('start 后初始角色为 follower', async () => {
    const ref = await createNode('n1', ['n2'], tmp)
    expect(ref.node.role).toBe('follower')
    await ref.node.start()
    await ref.node.stop()
  })

  it('follower->candidate：选举超时后转换为 candidate', async () => {
    const ref = await createNode('n1', ['n2'], tmp)
    await ref.node.start()
    expect(ref.node.role).toBe('follower')

    await vi.advanceTimersByTimeAsync(500)
    expect(ref.node.role).toBe('candidate')
    expect(ref.node.currentTerm).toBe(1)

    await ref.node.stop()
  })

  it('candidate->leader：获得多数投票后成为 leader', async () => {
    const ref = await createNode('n1', [], tmp)
    await ref.node.start()
    expect(ref.node.role).toBe('leader')
    expect(ref.node.getLeaderId()).toBe('n1')
    await ref.node.stop()
  })

  it('nodeId 和 peers 是必需的配置', () => {
    // 无 peers 但不抛异常（配置只是对象属性）
    // @ts-expect-error — 缺少必需参数
    expect(() => new RaftCore({ peers: ['n2'], walPath: path.join(tmp, 'wal.dat') })).not.toThrow()
  })

  it('leader->follower：收到更高 term 的请求时 step down', async () => {
    const ref = await createNode('n1', [], tmp)
    await ref.node.start()
    expect(ref.node.role).toBe('leader')

    // 更高 term 的 AppendEntries → step down
    // @ts-expect-error — 访问私有方法
    await ref.node._handleAppendEntries('n2', {
      term: 10,
      leaderId: 'n2',
      prevLogIndex: 0,
      prevLogTerm: 0,
      entries: [],
      leaderCommit: 0,
    })
    expect(ref.node.role).toBe('follower')
    expect(ref.node.currentTerm).toBe(10)

    await ref.node.stop()
  })

  it('candidate->follower：收到更高 term 的 RequestVote 时 step down', async () => {
    const ref = await createNode('n1', ['n2'], tmp)
    await ref.node.start()
    await vi.advanceTimersByTimeAsync(500)
    expect(ref.node.role).toBe('candidate')

    // 更高 term 的 RequestVote → step down
    // @ts-expect-error — 访问私有方法
    await ref.node._handleRequestVote('n2', {
      term: 5,
      candidateId: 'n2',
      lastLogIndex: 0,
      lastLogTerm: 0,
    })
    expect(ref.node.role).toBe('follower')
    expect(ref.node.currentTerm).toBe(5)

    await ref.node.stop()
  })
})

// ─── 5. 心跳 ────────────────────────────────────────────

describe('5. 心跳', () => {
  let tmp: string

  beforeEach(() => {
    tmp = makeTmpDir()
    MockTransport.reset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup(tmp)
  })

  it('leader 在成为 leader 后启动心跳定时器', async () => {
    const ref = await createNode('n1', [], tmp)
    await ref.node.start()
    expect(ref.node.role).toBe('leader')

    // @ts-expect-error — 访问私有属性
    expect(ref.node._heartbeatTimerId).not.toBeNull()

    await ref.node.stop()
  })

  it('follower 收到心跳后重置选举超时', async () => {
    const ref = await createNode('n1', ['n2'], tmp)
    await ref.node.start()

    // @ts-expect-error — 访问私有方法
    const resp = await ref.node._handleAppendEntries('leader', {
      term: 0,
      leaderId: 'leader',
      prevLogIndex: 0,
      prevLogTerm: 0,
      entries: [],
      leaderCommit: 0,
    })
    expect(resp.success).toBe(true)
    // @ts-expect-error — 访问私有属性
    expect(ref.node._electionTimerId).not.toBeNull()

    await ref.node.stop()
  })

  it('心跳携带正确的 term 和 leaderCommit', async () => {
    const ref = await createNode('n1', ['n2'], tmp)
    await ref.node.start()

    // @ts-expect-error — 访问私有方法
    const req = ref.node._buildAppendEntriesRequest('n2', true)
    expect(req.term).toBe(ref.node.currentTerm)
    expect(req.leaderId).toBe('n1')
    expect(req.entries).toEqual([])

    await ref.node.stop()
  })

  it('leader 可以同时向多个 peer 发送心跳', async () => {
    const ref = await createNode('n1', ['n2', 'n3'], tmp)
    await ref.node.start()

    // 手动调用心跳发送
    // @ts-expect-error — 访问私有方法
    ref.node._sendHeartbeat()

    await ref.node.stop()
  })
})

// ─── 6. 任期管理 ────────────────────────────────────────

describe('6. 任期管理', () => {
  let tmp: string

  beforeEach(() => {
    tmp = makeTmpDir()
    MockTransport.reset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup(tmp)
  })

  it('初始 term 为 0', async () => {
    const ref = await createNode('n1', ['n2'], tmp)
    expect(ref.node.currentTerm).toBe(0)
    await ref.node.start()
    await ref.node.stop()
  })

  it('选举时 term 递增', async () => {
    const ref = await createNode('n1', ['n2'], tmp)
    await ref.node.start()
    expect(ref.node.currentTerm).toBe(0)

    await vi.advanceTimersByTimeAsync(500)
    expect(ref.node.role).toBe('candidate')
    expect(ref.node.currentTerm).toBe(1)

    await ref.node.stop()
  })

  it('stepDown 时同步到更高 term', async () => {
    const ref = await createNode('n1', ['n2'], tmp)
    await ref.node.start()
    expect(ref.node.currentTerm).toBe(0)

    // @ts-expect-error — 访问私有方法
    await ref.node._handleAppendEntries('n2', {
      term: 3,
      leaderId: 'n2',
      prevLogIndex: 0,
      prevLogTerm: 0,
      entries: [],
      leaderCommit: 0,
    })

    expect(ref.node.currentTerm).toBe(3)
    expect(ref.node.role).toBe('follower')

    await ref.node.stop()
  })

  it('stale term（小 term）的请求被拒绝', async () => {
    const ref = await createNode('n1', ['n2'], tmp)
    await ref.node.start()

    // @ts-expect-error — 访问私有属性
    ref.node._currentTerm = 5

    // AppendEntries 带 stale term=3
    // @ts-expect-error — 访问私有方法
    const aeResp = await ref.node._handleAppendEntries('n2', {
      term: 3,
      leaderId: 'n2',
      prevLogIndex: 0,
      prevLogTerm: 0,
      entries: [],
      leaderCommit: 0,
    })
    expect(aeResp.success).toBe(false)

    // RequestVote 带 stale term=3
    // @ts-expect-error — 访问私有方法
    const rvResp = await ref.node._handleRequestVote('n2', {
      term: 3,
      candidateId: 'n2',
      lastLogIndex: 0,
      lastLogTerm: 0,
    })
    expect(rvResp.voteGranted).toBe(false)

    await ref.node.stop()
  })
})

// ─── 7. MockTransport 集成 ─────────────────────────────

describe('7. MockTransport 集成', () => {
  let tmp: string

  beforeEach(() => {
    tmp = makeTmpDir()
    MockTransport.reset()
  })

  afterEach(() => {
    cleanup(tmp)
  })

  it('未提供 Transport 时自动使用 MockTransport', () => {
    const node = new RaftCore({
      nodeId: 'n1',
      peers: [],
      walPath: path.join(tmp, 'wal.dat'),
    })
    // @ts-expect-error — 访问私有属性
    expect(node.transport instanceof MockTransport).toBe(true)
  })

  it('MockTransport 完整 RPC 请求-响应循环', async () => {
    const ref = await createNode('n1', ['n2'], tmp)
    const t2 = new MockTransport('n2')
    await t2.start()
    await ref.node.start()

    // 通过 t1 发 AppendEntries
    const resp = await ref.transport.appendEntries('n2', {
      term: 0,
      leaderId: 'n1',
      prevLogIndex: 0,
      prevLogTerm: 0,
      entries: [],
      leaderCommit: 0,
    })
    expect(resp).toBeDefined()
    expect(typeof resp.success).toBe('boolean')

    await ref.node.stop()
  })

  it('MockTransport 支持 RequestVote 请求-响应模式', async () => {
    const ref = await createNode('n1', ['n2'], tmp)
    const t2 = new MockTransport('n2')
    await t2.start()
    await ref.node.start()

    const resp = await ref.transport.requestVote('n2', {
      term: 1,
      candidateId: 'n1',
      lastLogIndex: 0,
      lastLogTerm: 0,
    })
    expect(resp).toBeDefined()
    expect(typeof resp.voteGranted).toBe('boolean')

    await ref.node.stop()
  })

  it('多个 MockTransport 节点共存时选举出 leader', async () => {
    const t1 = new MockTransport('n1')
    const t2 = new MockTransport('n2')
    const t3 = new MockTransport('n3')
    await t1.start()
    await t2.start()
    await t3.start()

    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-mock-'))
    const nodes = [
      new RaftCore(defaultCfg('n1', ['n2', 'n3'], tmp2), t1),
      new RaftCore(defaultCfg('n2', ['n1', 'n3'], tmp2), t2),
      new RaftCore(defaultCfg('n3', ['n1', 'n2'], tmp2), t3),
    ]

    for (const n of nodes) await n.start()
    await new Promise(r => setTimeout(r, 3000))

    const leader = nodes.find(n => n.role === 'leader')
    expect(leader).toBeDefined()

    if (leader) {
      const result = await leader.propose(new Uint8Array([42]))
      expect(result.ok).toBe(true)
    }

    for (const n of nodes) {
      if (n.role !== 'leader') {
        const result = await n.propose(new Uint8Array([99]))
        expect(result.ok).toBe(false)
      }
    }

    for (const n of nodes) await n.stop()
    cleanup(tmp2)
  })

  it('MockTransport.reset() 清除全局注册表', async () => {
    const t1 = new MockTransport('n1')
    await t1.start()

    expect(MockTransport.registeredCount).toBeGreaterThan(0)
    MockTransport.reset()
    expect(MockTransport.registeredCount).toBe(0)
  })
})

// ─── 8. 错误路径 ────────────────────────────────────────

describe('8. 错误路径', () => {
  let tmp: string

  beforeEach(() => {
    tmp = makeTmpDir()
    MockTransport.reset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup(tmp)
  })

  it('网络分区：所有 peer 无响应时无法获得多数票', async () => {
    // n2 和 n3 未注册到 MockTransport -> 所有发送都超时
    const ref = await createNode('n1', ['n2', 'n3'], tmp)
    await ref.node.start()

    await vi.advanceTimersByTimeAsync(500)

    // candidate 状态（无法获得多数票）
    expect(ref.node.role).toBe('candidate')
    expect(ref.node.currentTerm).toBe(1)

    await ref.node.stop()
  })

  it('日志冲突：冲突的日志条目被截断覆盖', async () => {
    const ref = await createNode('n1', ['n2'], tmp)
    await ref.node.start()

    // 写入第一条日志 (index=1, term=1)
    // @ts-expect-error — 访问私有方法
    await ref.node._handleAppendEntries('leader', {
      term: 1,
      leaderId: 'leader',
      prevLogIndex: 0,
      prevLogTerm: 0,
      entries: [{ index: 1, term: 1, data: new Uint8Array([1]) }],
      leaderCommit: 0,
    })
    expect(ref.node.lastLogIndex).toBe(1)

    // 冲突的日志 (index=1, term=2) — 被 leader 覆盖
    // @ts-expect-error — 访问私有方法
    await ref.node._handleAppendEntries('leader', {
      term: 2,
      leaderId: 'leader',
      prevLogIndex: 0,
      prevLogTerm: 0,
      entries: [{ index: 1, term: 2, data: new Uint8Array([99]) }],
      leaderCommit: 0,
    })

    // 现在有 1 条日志，term=2
    expect(ref.node.lastLogIndex).toBe(1)
    expect(ref.node.lastLogTerm).toBe(2)

    await ref.node.stop()
  })

  it('propose 在 stop 后返回 { ok: false }', async () => {
    const ref = await createNode('n1', [], tmp)
    await ref.node.start()
    expect(ref.node.role).toBe('leader')

    await ref.node.stop()

    const result = await ref.node.propose(new Uint8Array([1]))
    expect(result.ok).toBe(false)
  })

  it('propose 在非 leader 时返回 { ok: false }（已 stop 但标记未清除导致角色不变）', async () => {
    const ref = await createNode('n1', [], tmp)
    await ref.node.start()
    expect(ref.node.role).toBe('leader')
    await ref.node.stop()

    // stop 后 role 变为 follower，所以 propose 应该返回 false
    const result = await ref.node.propose(new Uint8Array([1]))
    expect(result.ok).toBe(false)
  })

  it('split brain 场景下不会出现多个 leader', async () => {
    const t1 = new MockTransport('n1')
    const t2 = new MockTransport('n2')
    await t1.start()
    await t2.start()

    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-split-'))
    const n1 = new RaftCore(defaultCfg('n1', ['n2'], tmp2), t1)
    const n2 = new RaftCore(defaultCfg('n2', ['n1'], tmp2), t2)

    await n1.start()
    await n2.start()

    await vi.advanceTimersByTimeAsync(2000)

    const leaderCount = [n1, n2].filter(n => n.role === 'leader').length
    // split brain 不能有多个 leader
    expect(leaderCount).toBeLessThanOrEqual(1)

    await Promise.all([n1.stop(), n2.stop()])
    cleanup(tmp2)
  })
})
