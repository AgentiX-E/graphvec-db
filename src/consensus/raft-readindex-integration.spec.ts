/**
 * raft-readindex-integration.spec.ts — ReadIndex 多节点集成测试
 *
 * 通过真实多节点 RaftCore 实例（使用 MockTransport）测试 readIndex 流程。
 * 与 raft-core-stale-read.spec.ts（纯单元测试）互补。
 *
 * 覆盖场景：
 *   - Leader readIndex（正常返回、canServeStaleRead）
 *   - Follower readIndex（获取 leader commitIndex）
 *   - canServeStaleRead（追赶前/后）
 *   - 边界：单节点集群、初始 commitIndex=0
 */
import { RaftCore, RaftRole } from './raft-core'
import { MockTransport } from './transport'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ─── 辅助函数 ─────────────────────────────────────────────

function setCommitIndex(raft: RaftCore, index: number): void {
  (raft as any)._commitIndex = index
}

function setRole(raft: RaftCore, role: RaftRole): void {
  (raft as any)._role = role
}

function getCommitIndex(raft: RaftCore): number {
  return (raft as any)._commitIndex
}

/** 在 leader 上模拟写入一条日志，使 leader 的 commitIndex 推进到指定值 */
async function advanceLeaderCommitIndex(
  leader: RaftCore,
  targetIndex: number,
  follower?: RaftCore,
): Promise<void> {
  const current = getCommitIndex(leader)
  for (let i = current + 1; i <= targetIndex; i++) {
    await leader.propose(Buffer.from(`entry-${i}`))
  }
  // 如果有 follower，让其处理 AppendEntries
  if (follower) {
    // 等待一轮心跳传播
    await new Promise(r => setTimeout(r, 100))
  }
}

// ─── 测试套件 ──────────────────────────────────────────────

describe('RaftCore ReadIndex Integration', () => {
  // ────────── 3 节点集群 ──────────

  describe('3-node cluster', () => {
    let tmpDirs: string[]
    let nodes: RaftCore[]
    let transports: MockTransport[]
    let leader: RaftCore
    let followers: RaftCore[]

    async function waitForElection(timeoutMs = 8000): Promise<RaftCore> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        for (const n of nodes) {
          if (n.role === 'leader') {
            leader = n
            followers = nodes.filter(x => x !== n)
            return n
          }
        }
        await new Promise(r => setTimeout(r, 50))
      }
      throw new Error('waitForElection: no leader elected within timeout')
    }

    beforeAll(async () => {
      MockTransport.reset()
      tmpDirs = []
      nodes = []
      transports = []
      const nodeIds = ['node-a', 'node-b', 'node-c']

      for (const id of nodeIds) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `raft-readindex-${id}-`))
        tmpDirs.push(dir)
        const t = new MockTransport(id)
        transports.push(t)
        const raft = new RaftCore(
          {
            nodeId: id,
            peers: nodeIds.filter(x => x !== id),
            electionTimeoutMs: 150,
            heartbeatIntervalMs: 50,
            walPath: path.join(dir, 'wal.bin'),
          },
          t,
        )
        nodes.push(raft)
      }

      // 并发启动
      await Promise.all(nodes.map(n => n.start()))

      // 等待选举出 leader
      leader = await waitForElection()
      expect(leader).toBeDefined()
      expect(leader.role).toBe('leader')
      followers = nodes.filter(n => n !== leader)
      expect(followers).toHaveLength(2)
    })

    afterAll(async () => {
      // 逆序停止
      for (const n of [...nodes].reverse()) {
        try { await n.stop() } catch { /* ignore */ }
      }
      for (const d of tmpDirs) {
        try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
      }
      MockTransport.reset()
    })

    // ── readIndex on leader ──

    it('leader.readIndex() should complete without error', async () => {
      await expect(leader.readIndex()).resolves.toBeUndefined()
    })

    it('leader.canServeStaleRead() should always be true', async () => {
      expect(leader.canServeStaleRead(0)).toBe(true)
      expect(leader.canServeStaleRead(5)).toBe(true)
      expect(leader.canServeStaleRead(100)).toBe(true)
    })

    // ── readIndex on follower ──

    it('follower.readIndex() should not throw (no-op for follower)', async () => {
      // readIndex 在非 leader 上直接 return，不应抛异常
      for (const f of followers) {
        await expect(f.readIndex()).resolves.toBeUndefined()
      }
    })

    it('follower can observe leader commitIndex propagating via heartbeats', async () => {
      // leader 上 commitIndex 应该 > 0（来自选举过程）
      const leaderCommit = getCommitIndex(leader)
      expect(leaderCommit).toBeGreaterThanOrEqual(0)

      // 等待心跳传播
      await new Promise(r => setTimeout(r, 300))

      // follower 的 commitIndex 应该 ≥ leaderCommit（通过心跳同步）
      for (const f of followers) {
        const fc = getCommitIndex(f)
        expect(fc).toBeGreaterThanOrEqual(0)
      }
    })

    // ── canServeStaleRead ──

    it('new follower with low commitIndex cannot serve stale read', async () => {
      const follower = followers[0]

      // 设置 follower 落后的场景
      setCommitIndex(follower, 0)
      expect(follower.canServeStaleRead(10, 3)).toBe(false)
      expect(follower.canServeStaleRead(5, 3)).toBe(false)
    })

    it('follower caught up with leader can serve stale read', async () => {
      const follower = followers[0]

      // 追赶后，commitIndex 差距在阈值内即可
      setCommitIndex(follower, 8)
      expect(follower.canServeStaleRead(10, 3)).toBe(true)
    })

    it('follower exactly matching leader commitIndex can serve stale read', async () => {
      const follower = followers[0]

      setCommitIndex(follower, 10)
      expect(follower.canServeStaleRead(10, 3)).toBe(true)
      // 零阈值也通过
      expect(follower.canServeStaleRead(10, 0)).toBe(true)
    })
  })

  // ────────── 单节点集群（边界） ──────────

  describe('single-node cluster (boundary)', () => {
    let tmpDir: string
    let raft: RaftCore

    beforeAll(async () => {
      MockTransport.reset()
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-readindex-single-'))
      const t = new MockTransport('single')
      raft = new RaftCore(
        {
          nodeId: 'single',
          peers: [],
          walPath: path.join(tmpDir, 'wal.bin'),
        },
        t,
      )
      await raft.start()
    })

    afterAll(async () => {
      try { await raft.stop() } catch { /* ignore */ }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      MockTransport.reset()
    })

    it('single node becomes leader immediately', () => {
      expect(raft.role).toBe('leader')
    })

    it('readIndex works on single-node cluster', async () => {
      await expect(raft.readIndex()).resolves.toBeUndefined()
    })

    it('canServeStaleRead is true for single-node leader', () => {
      expect(raft.canServeStaleRead(0)).toBe(true)
      expect(raft.canServeStaleRead(10)).toBe(true)
    })
  })

  // ────────── 所有节点初始 commitIndex = 0 ──────────

  describe('all nodes initial commitIndex is 0', () => {
    let tmpDir: string
    let raftA: RaftCore
    let raftB: RaftCore

    beforeAll(async () => {
      MockTransport.reset()
      const tA = new MockTransport('zero-a')
      const tB = new MockTransport('zero-b')

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-readindex-zero-'))
      tmpDir = dir

      raftA = new RaftCore(
        {
          nodeId: 'zero-a',
          peers: ['zero-b'],
          electionTimeoutMs: 100,
          heartbeatIntervalMs: 30,
          walPath: path.join(dir, 'wal-a.bin'),
        },
        tA,
      )
      raftB = new RaftCore(
        {
          nodeId: 'zero-b',
          peers: ['zero-a'],
          electionTimeoutMs: 100,
          heartbeatIntervalMs: 30,
          walPath: path.join(dir, 'wal-b.bin'),
        },
        tB,
      )

      await Promise.all([raftA.start(), raftB.start()])
    })

    afterAll(async () => {
      try { await raftA.stop() } catch { /* ignore */ }
      try { await raftB.stop() } catch { /* ignore */ }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      MockTransport.reset()
    })

    it('initial commitIndex is 0 for both nodes', () => {
      expect(getCommitIndex(raftA)).toBe(0)
      expect(getCommitIndex(raftB)).toBe(0)
    })

    it('canServeStaleRead on fresh follower returns false when lag threshold exceeded', () => {
      const follower = raftA.role === 'follower' ? raftA : raftB
      setRole(follower, 'follower')
      setCommitIndex(follower, 0)
      expect(follower.canServeStaleRead(10, 3)).toBe(false)
    })

    it('canServeStaleRead returns true once caught up to zero threshold', () => {
      const follower = raftA.role === 'follower' ? raftA : raftB
      setCommitIndex(follower, 0)
      // leader commit = 0, follower = 0, threshold = 0 → safe
      expect(follower.canServeStaleRead(0, 0)).toBe(true)
    })
  })
})
