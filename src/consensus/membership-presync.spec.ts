/**
 * membership-presync.spec.ts — PreSync 单元测试
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { PreSyncManager, DataSource } from './membership-presync'
import { MembershipTransport } from './app-membership-manager'

// ── Mock Transport ──

class MockPresyncTransport implements MembershipTransport {
  private _listeners: Array<(from: string, msg: any) => void> = []
  private _sentMessages: Array<{ to: string; msg: any }> = []
  private _peers: Array<{ nodeId: string; addr: string }>

  constructor(peers: Array<{ nodeId: string; addr: string }>) {
    this._peers = peers
  }

  async send(peerId: string, msg: any): Promise<void> {
    this._sentMessages.push({ to: peerId, msg })
    for (const listener of this._listeners) {
      listener(peerId, msg)
    }
  }

  async broadcast(msg: any): Promise<void> {
    for (const peer of this._peers) {
      if (peer.nodeId === this._peers[0].nodeId) continue // skip self
      for (const listener of this._listeners) {
        listener(peer.nodeId, msg)
      }
    }
  }

  onMessage(cb: (from: string, msg: any) => void): void {
    this._listeners.push(cb)
  }

  getPeers(): Array<{ nodeId: string; addr: string }> {
    return [...this._peers]
  }

  /** Inject a message from a simulated peer */
  inject(from: string, msg: any): void {
    for (const listener of this._listeners) {
      listener(from, msg)
    }
  }

  getSentMessages(): Array<{ to: string; msg: any }> {
    return [...this._sentMessages]
  }

  clearMessages(): void {
    this._sentMessages = []
  }
}

// ── Mock DataSource ──

function createMockDataSource(isLeader: boolean = true): DataSource {
  return {
    exportSnapshot: vi.fn().mockReturnValue(Buffer.from('mock-snapshot-data')),
    getCommittedEntries: vi.fn().mockReturnValue([
      { index: 1, term: 1, data: Buffer.from('entry-1') },
      { index: 2, term: 1, data: Buffer.from('entry-2') },
      { index: 3, term: 2, data: Buffer.from('entry-3') },
    ]),
    getCommitIndex: vi.fn().mockReturnValue(3),
    getCurrentTerm: vi.fn().mockReturnValue(2),
    isLeader: vi.fn().mockReturnValue(isLeader),
  }
}

// ── Tests ──

describe('PreSyncManager', () => {
  let leaderTransport: MockPresyncTransport
  let followerTransport: MockPresyncTransport
  let leaderManager: PreSyncManager
  let followerManager: PreSyncManager
  let leaderResult: vi.Mock
  let followerResult: vi.Mock

  beforeEach(() => {
    leaderTransport = new MockPresyncTransport([
      { nodeId: 'leader', addr: 'tcp://leader:7001' },
      { nodeId: 'joiner', addr: 'tcp://joiner:7001' },
    ])
    followerTransport = new MockPresyncTransport([
      { nodeId: 'joiner', addr: 'tcp://joiner:7001' },
      { nodeId: 'leader', addr: 'tcp://leader:7001' },
    ])

    leaderResult = vi.fn()
    followerResult = vi.fn()

    leaderManager = new PreSyncManager({
      nodeId: 'leader',
      transport: leaderTransport,
      dataSource: createMockDataSource(true),
      onResult: leaderResult,
      timeoutMs: 5000,
    })

    followerManager = new PreSyncManager({
      nodeId: 'joiner',
      transport: followerTransport,
      dataSource: createMockDataSource(false), // joiner is not leader
      onResult: followerResult,
      timeoutMs: 5000,
    })

    leaderManager.start()
    followerManager.start()
  })

  afterEach(() => {
    leaderManager.stop()
    followerManager.stop()
  })

  test('should reject sync when not leader', async () => {
    const transport = new MockPresyncTransport([])
    const nonLeader = new PreSyncManager({
      nodeId: 'follower',
      transport,
      dataSource: createMockDataSource(false),
      onResult: () => {},
    })

    const result = await nonLeader.startSync('some-peer')
    expect(result).toBe(false)
  })

  test('should reject duplicate sync', async () => {
    // 模拟正在同步
    await leaderManager.startSync('joiner')

    const result = await leaderManager.startSync('joiner')
    expect(result).toBe(false)
  })

  test('should start sync and send pre-sync-start message', async () => {
    const promise = leaderManager.startSync('joiner')

    const messages = leaderTransport.getSentMessages()
    const startMsg = messages.find(m => m.msg.type === 'pre-sync-start')
    expect(startMsg).toBeDefined()
    expect(startMsg!.to).toBe('joiner')
    expect(startMsg!.msg.term).toBe(2)
    expect(startMsg!.msg.commitIndex).toBe(3)

    // 清理
    followerTransport.inject('joiner', { type: 'pre-sync-abort', seq: startMsg!.msg.seq, from: 'joiner' })
    await promise.catch(() => {})
  })

  test('should send snapshot and log chunks during sync', async () => {
    const promise = leaderManager.startSync('joiner').catch(() => {})

    // await next tick for async sends to complete
    await new Promise(r => setTimeout(r, 10))

    const messages = leaderTransport.getSentMessages()
    const types = messages.map(m => m.msg.type)
    expect(types).toContain('pre-sync-start')
    expect(types).toContain('pre-sync-snapshot')
    expect(types).toContain('pre-sync-log-chunk')
    expect(types).toContain('pre-sync-complete')

    // 完成同步（通过 ready 响应）
    const completeMsg = messages.find(m => m.msg.type === 'pre-sync-complete')
    expect(completeMsg).toBeDefined()

    // 模拟 joiner 回复 ready
    const startMsg = messages.find(m => m.msg.type === 'pre-sync-start')
    leaderTransport.inject('joiner', {
      type: 'pre-sync-ready',
      seq: startMsg!.msg.seq,
      from: 'joiner',
      targetPeerId: 'leader',
      ready: true,
    })

    await promise
    expect(leaderResult).toHaveBeenCalledWith(true, 'joiner')
  })

  test('should timeout if no ready response', async () => {
    const isolateTransport = new MockPresyncTransport([
      { nodeId: 'leader', addr: 'tcp://l:7001' },
      { nodeId: 'joiner', addr: 'tcp://j:7001' },
    ])

    const isolatedResult = vi.fn()
    const shortTimeout = new PreSyncManager({
      nodeId: 'leader',
      transport: isolateTransport,
      dataSource: createMockDataSource(true),
      onResult: isolatedResult,
      timeoutMs: 50, // 50ms 超时
    })
    shortTimeout.start()

    const promise = shortTimeout.startSync('joiner')

    // 不注入 ready，等超时
    await promise
    expect(shortTimeout.isSyncing('joiner')).toBe(false)

    shortTimeout.stop()
  })

  test('should abort sync on pre-sync-abort', async () => {
    const promise = leaderManager.startSync('joiner').catch(() => {})

    const messages = leaderTransport.getSentMessages()
    const startMsg = messages.find(m => m.msg.type === 'pre-sync-start')

    leaderTransport.inject('joiner', {
      type: 'pre-sync-abort',
      seq: startMsg!.msg.seq,
      from: 'joiner',
      targetPeerId: 'leader',
      error: 'Not ready',
    })

    await promise
    expect(leaderResult).toHaveBeenCalledWith(false, 'joiner')
  })

  test('follower should respond with ready on complete', async () => {
    // 模拟 leader 发送的消息
    followerTransport.inject('leader', {
      type: 'pre-sync-start',
      seq: 0,
      from: 'leader',
      targetPeerId: 'joiner',
      term: 2,
      commitIndex: 3,
    })

    followerTransport.inject('leader', {
      type: 'pre-sync-snapshot',
      seq: 0,
      from: 'leader',
      targetPeerId: 'joiner',
      term: 2,
      snapshot: Buffer.from('test-snapshot'),
    })

    followerTransport.inject('leader', {
      type: 'pre-sync-complete',
      seq: 0,
      from: 'leader',
      targetPeerId: 'joiner',
      term: 2,
      commitIndex: 3,
    })

    // follower 应该发出 ready
    const sentMessages = followerTransport.getSentMessages()
    const readyMsg = sentMessages.find(m => m.msg.type === 'pre-sync-ready')
    expect(readyMsg).toBeDefined()
    expect(readyMsg!.msg.ready).toBe(true)
  })

  test('should return false on error during sync', async () => {
    const errorTransport = new MockPresyncTransport([
      { nodeId: 'leader', addr: 'tcp://l:7001' },
      { nodeId: 'joiner', addr: 'tcp://j:7001' },
    ])

    // 让 send 抛出异常
    const originalSend = errorTransport.send.bind(errorTransport)
    errorTransport.send = async () => { throw new Error('Transport error') }

    const errorManager = new PreSyncManager({
      nodeId: 'leader',
      transport: errorTransport,
      dataSource: createMockDataSource(true),
      onResult: vi.fn(),
    })
    errorManager.start()

    const result = await errorManager.startSync('joiner')
    expect(result).toBe(false)

    errorManager.stop()
  })

  test('should report isSyncing correctly', () => {
    expect(leaderManager.isSyncing('joiner')).toBe(false)

    // 手动设置（因为 sync 是异步的）
    leaderManager.startSync('joiner')

    expect(leaderManager.isSyncing('joiner')).toBe(true)

    // 清理
    const messages = leaderTransport.getSentMessages()
    const startMsg = messages.find(m => m.msg.type === 'pre-sync-start')
    if (startMsg) {
      leaderTransport.inject('joiner', {
        type: 'pre-sync-abort',
        seq: startMsg.msg.seq,
        from: 'joiner',
        targetPeerId: 'leader',
      })
    }
  })

  test('should stop all ongoing syncs on stop', () => {
    leaderManager.startSync('joiner')
    expect(leaderManager.isSyncing('joiner')).toBe(true)

    leaderManager.stop()

    expect(leaderManager.isSyncing('joiner')).toBe(false)
  })

  test('should handle multiple concurrent syncs', async () => {
    const multiTransport = new MockPresyncTransport([
      { nodeId: 'leader', addr: 'tcp://l:7001' },
      { nodeId: 'peer-a', addr: 'tcp://a:7001' },
      { nodeId: 'peer-b', addr: 'tcp://b:7001' },
    ])

    const multiManager = new PreSyncManager({
      nodeId: 'leader',
      transport: multiTransport,
      dataSource: createMockDataSource(true),
      onResult: vi.fn(),
      timeoutMs: 5000,
    })
    multiManager.start()

    const p1 = multiManager.startSync('peer-a').catch(() => {})
    const p2 = multiManager.startSync('peer-b').catch(() => {})

    expect(multiManager.isSyncing('peer-a')).toBe(true)
    expect(multiManager.isSyncing('peer-b')).toBe(true)

    // abort both
    const messages = multiTransport.getSentMessages()
    const seqA = messages.find(m => m.msg.type === 'pre-sync-start' && m.to === 'peer-a')?.msg.seq
    const seqB = messages.find(m => m.msg.type === 'pre-sync-start' && m.to === 'peer-b')?.msg.seq

    multiTransport.inject('peer-a', { type: 'pre-sync-abort', seq: seqA, from: 'peer-a' })
    multiTransport.inject('peer-b', { type: 'pre-sync-abort', seq: seqB, from: 'peer-b' })

    await Promise.all([p1, p2])
    expect(multiManager.isSyncing('peer-a')).toBe(false)
    expect(multiManager.isSyncing('peer-b')).toBe(false)

    multiManager.stop()
  })
})
