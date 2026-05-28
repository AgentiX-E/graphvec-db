/**
 * raft-core-stale-read.spec.ts — Q05: Follower/Stale read 单元测试
 *
 * 测试 RaftCore 的 canServeStaleRead() 和 getCommitIndex()
 * 不依赖完整的 Raft 集群，直接设置内部状态测试。
 */
import { RaftCore } from './raft-core'
import { MockTransport } from './transport'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

describe('RaftCore StaleRead', () => {
  let tmpDir: string
  let mockTransport: MockTransport

  // Q05 测试专用：通过内部方法直接设置 commitIndex
  function setCommitIndex(raft: RaftCore, index: number): void {
    (raft as any)._commitIndex = index
  }

  function setRole(raft: RaftCore, role: 'follower' | 'candidate' | 'leader'): void {
    (raft as any)._role = role
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-core-stale-'))
    mockTransport = new MockTransport('node-0')
  })

  afterEach(async () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  // ────────── Q05: canServeStaleRead ──────────

  it('Q05: leader always returns true for canServeStaleRead', async () => {
    const raft = new RaftCore({
      nodeId: 'node-0',
      peers: ['node-1'],
      walPath: path.join(tmpDir, 'wal-0.bin'),
    }, mockTransport)
    await raft.start()
    setRole(raft, 'leader')
    setCommitIndex(raft, 10)

    const result = raft.canServeStaleRead(10, 3)
    expect(result).toBe(true)
    await raft.stop()
  })

  it('Q05: follower with caught-up commitIndex returns true', async () => {
    const raft = new RaftCore({
      nodeId: 'node-0',
      peers: ['node-1'],
      walPath: path.join(tmpDir, 'wal-1.bin'),
    }, mockTransport)
    await raft.start()
    setRole(raft, 'follower')
    setCommitIndex(raft, 10)

    // follower commitIndex = 10, leader = 10, threshold = 3
    const result = raft.canServeStaleRead(10, 3)
    expect(result).toBe(true)
    await raft.stop()
  })

  it('Q05: follower within threshold returns true', async () => {
    const raft = new RaftCore({
      nodeId: 'node-0',
      peers: ['node-1'],
      walPath: path.join(tmpDir, 'wal-2.bin'),
    }, mockTransport)
    await raft.start()
    setRole(raft, 'follower')
    setCommitIndex(raft, 8)

    // follower = 8, leader = 10, threshold = 3 → safe (difference 2 ≤ 3)
    const result = raft.canServeStaleRead(10, 3)
    expect(result).toBe(true)
    await raft.stop()
  })

  it('Q05: follower beyond threshold returns false', async () => {
    const raft = new RaftCore({
      nodeId: 'node-0',
      peers: ['node-1'],
      walPath: path.join(tmpDir, 'wal-3.bin'),
    }, mockTransport)
    await raft.start()
    setRole(raft, 'follower')
    setCommitIndex(raft, 5)

    // follower = 5, leader = 10, threshold = 3 → unsafe (difference 5 > 3)
    const result = raft.canServeStaleRead(10, 3)
    expect(result).toBe(false)
    await raft.stop()
  })

  it('Q05: candidate always returns false', async () => {
    const raft = new RaftCore({
      nodeId: 'node-0',
      peers: ['node-1'],
      walPath: path.join(tmpDir, 'wal-4.bin'),
    }, mockTransport)
    await raft.start()
    setRole(raft, 'candidate')
    setCommitIndex(raft, 10)

    const result = raft.canServeStaleRead(10, 3)
    expect(result).toBe(false)
    await raft.stop()
  })

  it('Q05: zero threshold forces exact match', async () => {
    const raft = new RaftCore({
      nodeId: 'node-0',
      peers: ['node-1'],
      walPath: path.join(tmpDir, 'wal-5.bin'),
    }, mockTransport)
    await raft.start()
    setRole(raft, 'follower')
    setCommitIndex(raft, 9)

    // follower = 9, leader = 10, threshold = 0 → unsafe
    const result = raft.canServeStaleRead(10, 0)
    expect(result).toBe(false)

    // follower = 10, leader = 10, threshold = 0 → safe
    setCommitIndex(raft, 10)
    const resultExact = raft.canServeStaleRead(10, 0)
    expect(resultExact).toBe(true)
    await raft.stop()
  })

  // ────────── Q05: getCommitIndex ──────────

  it('Q05: getCommitIndex returns current commitIndex', async () => {
    const raft = new RaftCore({
      nodeId: 'node-0',
      peers: ['node-1'],
      walPath: path.join(tmpDir, 'wal-6.bin'),
    }, mockTransport)
    await raft.start()
    setCommitIndex(raft, 42)

    const index = raft.getCommitIndex()
    expect(index).toBe(42)
    await raft.stop()
  })

  it('Q05: getCommitIndex returns 0 for new raft', async () => {
    const raft = new RaftCore({
      nodeId: 'node-0',
      peers: ['node-1'],
      walPath: path.join(tmpDir, 'wal-7.bin'),
    }, mockTransport)
    await raft.start()

    // 初始状态 commitIndex = 0
    const index = raft.getCommitIndex()
    expect(index).toBe(0)
    await raft.stop()
  })
})
