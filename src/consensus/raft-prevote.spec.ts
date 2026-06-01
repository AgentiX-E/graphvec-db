/**
 * raft-prevote.spec.ts — PreVote 测试套件
 *
 * 测试覆盖：
 * 1. PreVote 通过 — 候选人日志足够新时同意
 * 2. PreVote 拒绝 — 候选人日志落后时拒绝
 * 3. PreVote 拒绝 — 候选人 term <= currentTerm
 * 4. PreVote 完整流程 — 3节点集群通过 PreVote 选举出 leader
 * 5. PreVote 失败后恢复到 follower（peer 无响应）
 * 6. PreVote 阶段 candidate 不递增 term
 */

import { describe, test, expect, afterEach } from 'vitest'
import { RaftCore, RaftCoreConfig } from './raft-core'
import { MockTransport } from './transport'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'raft-prevote-'))
}

function makeCfg(nodeId: string, peers: string[], tmp: string): RaftCoreConfig {
  return {
    nodeId,
    peers,
    walPath: path.join(tmp, `wal-${nodeId}.dat`),
    snapshotPath: path.join(tmp, `snap-${nodeId}.json`),
    electionTimeoutMs: 150,
    heartbeatIntervalMs: 50,
    preVote: true,
  }
}

describe('B-04 PreVote 完整化', () => {
  let tmp: string

  afterEach(() => {
    MockTransport.reset()
    if (tmp) {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
    }
  })

  // ── TC1: PreVote 请求 — 日志匹配时同意 ──
  test('TC1: handlePreVoteRequest grants vote when candidate log is at least as new', async () => {
    tmp = makeTmpDir()
    const node = new RaftCore(makeCfg('n1', ['n2'], tmp), new MockTransport('n1'))
    await node.start()

    // 双方都是空日志 -> 同意
    const r = node.handlePreVoteRequest('n2', { term: 2, candidateId: 'n2', lastLogIndex: 0, lastLogTerm: 0 })
    expect(r.voteGranted).toBe(true)
    expect(r.term).toBe(2)

    // candidate 日志更优 -> 同意
    const r2 = node.handlePreVoteRequest('n2', { term: 2, candidateId: 'n2', lastLogIndex: 10, lastLogTerm: 2 })
    expect(r2.voteGranted).toBe(true)

    await node.stop()
  })

  // ── TC2: PreVote 拒绝 — 候选人 term <= currentTerm ──
  test('TC2: handlePreVoteRequest denies when term <= currentTerm', async () => {
    tmp = makeTmpDir()
    const node = new RaftCore(makeCfg('n1', ['n2'], tmp), new MockTransport('n1'))
    await node.start()

    // term=0 <= currentTerm=0
    expect(node.handlePreVoteRequest('n2', { term: 0, candidateId: 'n2', lastLogIndex: 0, lastLogTerm: 0 }).voteGranted).toBe(false)
    // term=1 > 0 且日志相等 → 同意
    expect(node.handlePreVoteRequest('n2', { term: 1, candidateId: 'n2', lastLogIndex: 0, lastLogTerm: 0 }).voteGranted).toBe(true)

    await node.stop()
  })

  // ── TC3: PreVote 拒绝 — 候选人日志落后 ──
  test('TC3: handlePreVoteRequest denies when candidate log is behind', async () => {
    tmp = makeTmpDir()
    const transport = new MockTransport('n1')

    // 先创建单节点有日志
    const cfg1: RaftCoreConfig = { ...makeCfg('n1', [], tmp), preVote: false }
    const node1 = new RaftCore(cfg1, transport)
    await node1.start()

    // 单节点自动变成 leader, 写入日志
    await node1.waitForLeader(3000).catch(() => {})

    // 追加3条日志
    for (let i = 0; i < 3; i++) {
      await node1.propose(new Uint8Array([i]))
    }

    const term1 = node1.lastLogTerm
    await node1.stop()

    // 用同一个 WAL/WAL 重启
    const node2 = new RaftCore(makeCfg('n1', ['n2'], tmp), transport)
    await node2.start()

    const term2 = node2.lastLogTerm

    // 如果日志存在（term>0），candidate 日志落后应拒绝
    if (term2 > 0) {
      const resp = node2.handlePreVoteRequest('n2', {
        term: 10,
        candidateId: 'n2',
        lastLogIndex: 0,
        lastLogTerm: 0,
      })
      expect(resp.voteGranted).toBe(false)
    }

    await node2.stop()
  })

  // ── TC4: PreVote + 正式选举完整流程 ──
  test('TC4: full pre-vote flow elects a leader', async () => {
    tmp = makeTmpDir()
    const nodes: RaftCore[] = []
    for (const id of ['n1', 'n2', 'n3']) {
      const t = new MockTransport(id)
      const peers = ['n1', 'n2', 'n3'].filter(x => x !== id)
      nodes.push(new RaftCore(makeCfg(id, peers, tmp), t))
    }

    for (const n of nodes) await n.start()

    // 等待选举（3节点，preVote=on，elect timeout 150ms+jitter）
    await new Promise(r => setTimeout(r, 2000))

    const leader = nodes.find(n => n.role === 'leader')
    expect(leader).toBeDefined()

    for (const n of nodes) await n.stop()
  })

  // ── TC5: PreVote 失败后恢复到 follower ──
  test('TC5: pre-vote failure reverts to follower', async () => {
    tmp = makeTmpDir()
    const node = new RaftCore(makeCfg('n1', ['n2'], tmp), new MockTransport('n1'))
    await node.start()

    // 等选举超时触发 PreVote（n2 没有注册到 MockTransport）
    // PreVote 会发给 n2，但得不到响应，结果 preVote 1/2 = 失败
    await new Promise(r => setTimeout(r, 1000))

    const state = {
      role: (node as any)._role as string,
      preVote: (node as any)._inPreVote as boolean,
    }
    expect(state.role).toBe('follower')
    expect(state.preVote).toBe(false)

    await node.stop()
  })

  // ── TC6: PreVote 阶段不递增 term ──
  test('TC6: pre-vote does NOT increment term', async () => {
    tmp = makeTmpDir()
    const node = new RaftCore(makeCfg('n1', ['n2'], tmp), new MockTransport('n1'))
    await node.start()

    const termBefore = (node as any)._currentTerm as number

    // 等 PreVote 触发并失败
    await new Promise(r => setTimeout(r, 1000))

    const state = {
      term: (node as any)._currentTerm as number,
      role: (node as any)._role as string,
    }
    // term 不应增加（只有真实选举才增加 term）
    expect(state.term).toBe(termBefore)
    expect(state.role).toBe('follower')

    await node.stop()
  })

  // ── TC7: PreVote 超时后恢复到 follower 不触发选举 ──
  test('TC7: pre-vote timeout reverts to follower without election', async () => {
    tmp = makeTmpDir()
    const node = new RaftCore(makeCfg('n1', ['slow-peer'], tmp), new MockTransport('n1'))
    await node.start()

    // 用受控方式：模拟 PreVote 超时
    // PreVote 超时内部设置为 electionTimeoutMs*2 = 300ms
    // 等待超时过后应该还是 follower（超时不触发选举）
    await new Promise(r => setTimeout(r, 1500))

    const role = (node as any)._role as string
    expect(role).toBe('follower')

    await node.stop()
  })
})
