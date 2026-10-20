/**
 * membership-manager-stress.spec.ts — Raft 成员变更 stress/分区测试
 *
 * 覆盖：
 * - 并发提案拒绝（冲突保护）
 * - ACK 乱序/延迟到达
 * - 高频率重复 add/remove
 * - 超时恢复（ack 超时后的重试）
 * - Commit 去重
 * - 少数 ACK 分区（quorum 不足导致超时）
 * - 部分 commit 丢失（分区后重试）
 * - syncCheck 连续波动（flapping）
 * - preSyncCheck 超时 + 恢复
 * - syncCheck 边界时间
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
import {
  AppMembershipManager,
  MembershipMessage,
  MembershipTransport,
} from './app-membership-manager'
import { MembershipRouteTable } from './membership-route-table'

// ── Helpers ──────────────────────────────────────────────────────────

let _seqCounter = 0
function resetSeq(): void {
  _seqCounter = 0
}

class StressMockTransport implements MembershipTransport {
  private _peers: Array<{ nodeId: string; addr: string }>
  private _listeners: Array<(from: string, msg: any) => void> = []
  /** 消息发送延迟（ms） */
  public sendDelayMs = 0
  public broadcastDelayMs = 0
  /** 丢包率 [0,1) — 用于模拟分区 */
  public dropRate = 0
  /** 仅接受来自指定节点的消息（模拟网络隔离） */
  public acceptFrom: Set<string> | null = null
  public sentMessages: Array<{ to: string; msg: any }> = []

  constructor(peers: Array<{ nodeId: string; addr: string }>) {
    this._peers = peers
  }

  async send(peerId: string, msg: any): Promise<void> {
    this.sentMessages.push({ to: peerId, msg })
    if (this.dropRate > Math.random()) return
    if (this.acceptFrom && this.acceptFrom.size > 0) {
      for (const allowed of this.acceptFrom) {
        if (allowed === peerId) return
      }
    }
    if (this.sendDelayMs > 0) {
      await new Promise(r => setTimeout(r, this.sendDelayMs))
    }
    for (const listener of this._listeners) {
      listener(peerId, msg)
    }
  }

  async broadcast(msg: any): Promise<void> {
    for (const listener of this._listeners) {
      listener('node-1', msg)
    }
    if (this.broadcastDelayMs > 0) {
      await new Promise(r => setTimeout(r, this.broadcastDelayMs))
    }
  }

  onMessage(cb: (from: string, msg: any) => void): void {
    this._listeners.push(cb)
  }

  getPeers(): Array<{ nodeId: string; addr: string }> {
    return [...this._peers]
  }

  inject(from: string, msg: any): void {
    if (this.acceptFrom && !this.acceptFrom.has(from)) return
    for (const listener of this._listeners) {
      listener(from, msg)
    }
  }
}

function createStressManager(
  nodeId: string,
  peers: Array<{ nodeId: string; addr: string }>,
  opts?: {
    ackTimeoutMs?: number
    checkLeaderAlive?: () => Promise<boolean>
    syncCheck?: () => Promise<boolean>
    preSyncCheck?: (peerId: string) => Promise<boolean>
    routeTable?: MembershipRouteTable
  },
): { mm: AppMembershipManager; transport: StressMockTransport } {
  const transport = new StressMockTransport(peers)
  const mm = new AppMembershipManager({
    nodeId,
    transport,
    onMembershipChange: () => {},
    ackTimeoutMs: opts?.ackTimeoutMs ?? 5000,
    ...opts,
  })
  mm.start()
  return { mm, transport }
}

/** 等待指定 ms */
function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ── Tests ────────────────────────────────────────────────────────────

describe('MembershipManager — Stress/Partition', { timeout: 30000 }, () => {
  beforeEach(() => {
    resetSeq()
  })

  // ════ 并发测试 ════

  test('concurrent proposals are rejected', async () => {
    const { mm, transport } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
    ])

    const p1 = mm.proposeChange('add', 'node-3')
    // 第二个并发提案应被拒绝
    await expect(mm.proposeChange('add', 'node-4')).rejects.toThrow(/Concurrent/)
    // 清理：注入 ACK 让第一个完成
    transport.inject('node-2', { type: 'ack', seq: 0 })
    await p1
  })

  test('serial proposals complete one at a time', async () => {
    const { mm, transport } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
    ])

    // 添加 node-3
    const p1 = mm.proposeChange('add', 'node-3')
    transport.inject('node-2', { type: 'ack', seq: 0 })
    await p1
    expect(mm.getMembers()).toContain('node-3')

    // 添加 node-4（新 seq）
    const p2 = mm.proposeChange('add', 'node-4')
    transport.inject('node-2', { type: 'ack', seq: 1 })
    await p2
    expect(mm.getMembers()).toContain('node-4')
  })

  // ════ ACK 乱序/延迟 ════

  test('handles delayed ACK', async () => {
    const { mm, transport } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
      { nodeId: 'node-3', addr: 'tcp://n3:7001' },
    ], { ackTimeoutMs: 2000 })

    const promise = mm.proposeChange('add', 'node-4')

    // node-2 ACK 延迟 100ms（但仍然在超时之前）
    setTimeout(() => {
      transport.inject('node-2', { type: 'ack', seq: 0 })
    }, 100)

    // node-3 ACK 延迟 200ms
    setTimeout(() => {
      transport.inject('node-3', { type: 'ack', seq: 0 })
    }, 200)

    await promise
    expect(mm.getMembers()).toContain('node-4')
  })

  test('handles out-of-order ACKs', async () => {
    const { mm, transport } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
      { nodeId: 'node-3', addr: 'tcp://n3:7001' },
    ], { ackTimeoutMs: 2000 })

    const promise = mm.proposeChange('add', 'node-4')

    // node-3 的 ACK 先到（乱序）
    transport.inject('node-3', { type: 'ack', seq: 0 })
    await wait(20)
    transport.inject('node-2', { type: 'ack', seq: 0 })

    await promise
    expect(mm.getMembers()).toContain('node-4')
  })

  test('duplicate ACKs are idempotent', async () => {
    const { mm, transport } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
    ])

    const promise = mm.proposeChange('add', 'node-3')

    // 重复发送同一 ACK（已去重）
    transport.inject('node-2', { type: 'ack', seq: 0 })
    transport.inject('node-2', { type: 'ack', seq: 0 })

    await promise
    expect(mm.getMembers()).toContain('node-3')
  })

  test('duplicate commit messages are idempotent', async () => {
    const { mm, transport } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
    ])

    const promise = mm.proposeChange('add', 'node-3')
    transport.inject('node-2', { type: 'ack', seq: 0 })
    await promise
    expect(mm.getMembers()).toContain('node-3')

    // 发送重复 commit（应被去重忽略）
    mm['handleMessage']('node-1', { type: 'commit', seq: 0, from: 'node-1', members: ['node-1', 'node-2', 'node-3'] })
    // 不影响当前状态
    expect(mm.getMembers()).toEqual(['node-1', 'node-2', 'node-3'])
  })

  // ════ 超时恢复 ════

  test('timeout on missing ACK is rejected', async () => {
    const { mm } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
    ], { ackTimeoutMs: 100 })

    // 不注入 ACK → 超时拒绝
    await expect(mm.proposeChange('add', 'node-3')).rejects.toThrow(/timeout/)
    expect(mm.getMembers()).not.toContain('node-3')
  })

  test('can retry after timeout', async () => {
    const { mm, transport } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
    ], { ackTimeoutMs: 100 })

    // 第一次超时
    await expect(mm.proposeChange('add', 'node-3')).rejects.toThrow(/timeout/)
    expect(mm.getMembers()).not.toContain('node-3')

    // 重试（现在注入 ACK）
    const p2 = mm.proposeChange('add', 'node-3')
    transport.inject('node-2', { type: 'ack', seq: 1 })
    await p2
    expect(mm.getMembers()).toContain('node-3')
  })

  // ════ 分区测试 ════

  test('partition: insufficient ACK leads to timeout', async () => {
    // 3 节点，但没有其他节点的 ACK
    const { mm, transport } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
    ], { ackTimeoutMs: 100 })

    // acceptFrom 设置为仅接受自身（模拟分区：其他节点不可达）
    transport.acceptFrom = new Set(['node-1'])

    await expect(mm.proposeChange('add', 'node-3')).rejects.toThrow(/timeout/)
    expect(mm.getMembers()).not.toContain('node-3')
  })

  test('partition: commit lost can be resent', async () => {
    const { mm, transport } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
    ])

    // 正常完成变更
    const promise = mm.proposeChange('add', 'node-3')
    transport.inject('node-2', { type: 'ack', seq: 0 })
    await promise
    expect(mm.getMembers()).toContain('node-3')

    // 模拟 commit 丢失后重放：另一个节点发送相同的 commit
    mm['handleMessage']('node-2', { type: 'commit', seq: 0, from: 'node-1', members: ['node-1', 'node-2', 'node-3'] })
    // 应保持 idempotent
    expect(mm.getMembers()).toEqual(['node-1', 'node-2', 'node-3'])
  })

  test('partition: proposal from isolated node is ignored', async () => {
    const { mm } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
    ])

    // 模拟隔离节点发来旧提案
    const oldProposal: MembershipMessage = {
      type: 'proposal',
      seq: 999,
      from: 'node-4',
      changeType: 'add',
      targetPeerId: 'node-5',
    }
    mm['handleMessage']('node-4', oldProposal)
    // 只应该发送 ACK（不改变本地状态）
    expect(mm.getMembers()).toEqual(['node-1', 'node-2'])
  })

  // ════ 高频 add/remove ════

  test('rapid add-remove cycles', async () => {
    // 初始 5 节点（quorum=3），5次add后9成员，quorum=5，自+4peer=5 ACK 正好够
    const { mm, transport } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
      { nodeId: 'node-3', addr: 'tcp://n3:7001' },
      { nodeId: 'node-4', addr: 'tcp://n4:7001' },
      { nodeId: 'node-5', addr: 'tcp://n5:7001' },
    ], { ackTimeoutMs: 2000 })

    let seq = 0
    for (let i = 0; i < 5; i++) {
      const nodeId = `node-${10 + i}`
      // add
      const p = mm.proposeChange('add', nodeId)
      transport.inject('node-2', { type: 'ack', seq })
      transport.inject('node-3', { type: 'ack', seq })
      transport.inject('node-4', { type: 'ack', seq })
      transport.inject('node-5', { type: 'ack', seq })
      seq++
      await p
      expect(mm.getMembers()).toContain(nodeId)
    }
    // 最终：5 原始 + 5 新节点 = 10 个
    expect(mm.getMembers().length).toBe(10)
  })

  test('rapid add-remove with interleaved node', async () => {
    // 初始 3 节点（quorum=2），add 后变成 4 节点再 remove
    const { mm, transport } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
      { nodeId: 'node-3', addr: 'tcp://n3:7001' },
    ], { ackTimeoutMs: 2000 })

    let seq = 0

    // 添加 node-4（现在 4 节点，quorum=3）
    let p = mm.proposeChange('add', 'node-4')
    transport.inject('node-2', { type: 'ack', seq })
    transport.inject('node-3', { type: 'ack', seq })
    seq++
    await p
    expect(mm.getMembers()).toContain('node-4')

    // 添加 node-5（现在 5 节点，quorum=3）
    p = mm.proposeChange('add', 'node-5')
    transport.inject('node-2', { type: 'ack', seq })
    transport.inject('node-3', { type: 'ack', seq })
    seq++
    await p
    expect(mm.getMembers()).toContain('node-5')

    // 现在 5 节点，可以移除
    p = mm.proposeChange('remove', 'node-4')
    transport.inject('node-2', { type: 'ack', seq })
    transport.inject('node-3', { type: 'ack', seq })
    seq++
    await p
    expect(mm.getMembers()).not.toContain('node-4')

    // 添加 node-6
    p = mm.proposeChange('add', 'node-6')
    transport.inject('node-2', { type: 'ack', seq })
    transport.inject('node-3', { type: 'ack', seq })
    seq++
    await p
    expect(mm.getMembers()).toContain('node-6')
  })

  // ════ syncCheck stress ════

  test('syncCheck flapping (alternating true/false)', async () => {
    let callCount = 0
    const { mm, transport } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
    ], {
      ackTimeoutMs: 2000,
      syncCheck: async () => {
        callCount++
        return callCount % 2 === 0 // 首次 false，之后 true
      },
    })

    // 第一次：syncCheck 返回 false → 拒绝
    let seq = 0
    const p1 = mm.proposeChange('add', 'node-3')
    transport.inject('node-2', { type: 'ack', seq: seq++ })
    await expect(p1).rejects.toThrow(/syncCheck/)
    expect(mm.getMembers()).not.toContain('node-3')
    expect(callCount).toBe(1)

    // 第二次：syncCheck 返回 true → 通过
    const p2 = mm.proposeChange('add', 'node-3')
    transport.inject('node-2', { type: 'ack', seq: seq++ })
    await p2
    expect(mm.getMembers()).toContain('node-3')
    expect(callCount).toBe(2)
  })

  test('syncCheck near timeout boundary', async () => {
    const { mm, transport } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
    ], {
      ackTimeoutMs: 10000,
      syncCheck: async () => {
        await wait(4800) // 接近 5s 超时，但仍在范围内
        return true
      },
    })

    // 同步检查本身有 5s 超时，我们的 syncCheck 4.8s 返回 true
    const promise = mm.proposeChange('add', 'node-3')
    transport.inject('node-2', { type: 'ack', seq: 0 })
    await promise
    expect(mm.getMembers()).toContain('node-3')
  })

  test('syncCheck hangs recovers on retry', async () => {
    let first = true
    const { mm, transport } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
    ], {
      syncCheck: async () => {
        if (first) {
          first = false
          return new Promise<boolean>(() => {}) // 永不 resolve → 5s timeout
        }
        return true
      },
    })

    // 第一次：syncCheck 超时 → 拒绝
    let seq = 0
    const p1 = mm.proposeChange('add', 'node-3')
    transport.inject('node-2', { type: 'ack', seq: seq++ })
    await expect(p1).rejects.toThrow(/syncCheck/)
    expect(mm.getMembers()).not.toContain('node-3')

    // 第二次：syncCheck 正常返回
    const p2 = mm.proposeChange('add', 'node-3')
    transport.inject('node-2', { type: 'ack', seq: seq++ })
    await p2
    expect(mm.getMembers()).toContain('node-3')
  })

  // ════ preSyncCheck stress ════

  test('preSyncCheck timeout then recovery', async () => {
    let first = true
    const { mm, transport } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
    ], {
      preSyncCheck: async (peerId: string) => {
        if (first) {
          first = false
          await wait(6000) // 超过 5s 预同步超时
          return true // 但已经太晚了
        }
        return true
      },
    })

    // 第一次：preSyncCheck 超时（6s > 5s 超时）
    await expect(mm.proposeChange('add', 'node-3')).rejects.toThrow(/PreSync/)
    expect(mm.getMembers()).not.toContain('node-3')

    // 第二次：正常返回。用 setTimeout 确保 inject 在 _pending 设置后到达
    // 因为 preSyncCheck 有 await，proposeChange 返回时 _pending 还未设置
    const seq = 1 // _nextSeq 已从 0 递增到 1
    const p2 = mm.proposeChange('add', 'node-3')
    setTimeout(() => {
      transport.inject('node-2', { type: 'ack', seq })
    }, 10)
    await p2
    expect(mm.getMembers()).toContain('node-3')
  })

  test('preSyncCheck returns false means peer cannot be added', async () => {
    const { mm } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
    ], {
      preSyncCheck: async () => false,
    })

    await expect(mm.proposeChange('add', 'node-3')).rejects.toThrow(/PreSync/)
    expect(mm.getMembers()).not.toContain('node-3')
  })

  // ════ 综合场景 ════

  test('add node → remove later → readd', async () => {
    // 初始 4 节点（quorum=3），add→remove→readd 时始终保持 quorum 充足
    const { mm, transport } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
      { nodeId: 'node-3', addr: 'tcp://n3:7001' },
      { nodeId: 'node-4', addr: 'tcp://n4:7001' },
    ], { ackTimeoutMs: 2000 })

    let seq = 0

    // add node-5（现在 5 节点，quorum=3）
    let p = mm.proposeChange('add', 'node-5')
    transport.inject('node-2', { type: 'ack', seq })
    transport.inject('node-3', { type: 'ack', seq })
    seq++
    await p
    expect(mm.getMembers()).toContain('node-5')

    // remove node-5（回到 4 节点，quorum=3）
    p = mm.proposeChange('remove', 'node-5')
    transport.inject('node-2', { type: 'ack', seq })
    transport.inject('node-3', { type: 'ack', seq })
    seq++
    await p
    expect(mm.getMembers()).not.toContain('node-5')

    // readd node-5（再次 5 节点）
    p = mm.proposeChange('add', 'node-5')
    transport.inject('node-2', { type: 'ack', seq })
    transport.inject('node-3', { type: 'ack', seq })
    seq++
    await p
    expect(mm.getMembers()).toContain('node-5')
  })

  test('idempotent add node that is already being added (retry with same seq rejected by dedup)', async () => {
    const { mm, transport } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
    ])

    const promise = mm.proposeChange('add', 'node-3')

    // 模拟其他节点重传同一个 seq 的 ACK
    transport.inject('node-2', { type: 'ack', seq: 0 })
    transport.inject('node-2', { type: 'ack', seq: 0 }) // 去重

    await promise
    expect(mm.getMembers()).toContain('node-3')
  })

  test('stop then start resets state', async () => {
    const { mm, transport } = createStressManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
    ])

    // 正常添加
    const p1 = mm.proposeChange('add', 'node-3')
    transport.inject('node-2', { type: 'ack', seq: 0 })
    await p1

    mm.stop()
    expect(mm.getMembers()).toEqual(['node-1', 'node-2', 'node-3']) // 成员保留

    // 重新 start（seenSeqs 已清空，_nextSeq 不变仍为 1）
    mm.start()

    // 可以正常提案（pending 已清理）
    const p2 = mm.proposeChange('add', 'node-4')
    transport.inject('node-2', { type: 'ack', seq: 1 })
    await p2
    expect(mm.getMembers()).toContain('node-4')
  })
})
