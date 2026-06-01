/**
 * app-membership-manager.spec.ts — 应用层成员变更安全测试
 *
 * 覆盖：
 * - Remove 安全保护（<3 节点禁止）
 * - Leader 存活检查
 * - RouteTable 自动更新
 * - 正常 add/remove 流程
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { AppMembershipManager, MembershipMessage, MembershipTransport } from './app-membership-manager'
import { MembershipRouteTable } from './membership-route-table'

/** 内存传输层（测试用） */
class MockMembershipTransport implements MembershipTransport {
  private _peers: Array<{ nodeId: string; addr: string }>
  private _listeners: Array<(from: string, msg: any) => void> = []

  constructor(peers: Array<{ nodeId: string; addr: string }>) {
    this._peers = peers
  }

  async send(peerId: string, msg: any): Promise<void> {
    // 模拟发送
  }

  async broadcast(msg: any): Promise<void> {
    for (const listener of this._listeners) {
      listener('node-1', msg)
    }
  }

  onMessage(cb: (from: string, msg: any) => void): void {
    this._listeners.push(cb)
  }

  getPeers(): Array<{ nodeId: string; addr: string }> {
    return [...this._peers]
  }

  /** 注入消息（模拟远端节点） */
  inject(from: string, msg: any): void {
    for (const listener of this._listeners) {
      listener(from, msg)
    }
  }
}

function createManager(
  nodeId: string,
  peers: Array<{ nodeId: string; addr: string }>,
  opts?: { routeTable?: MembershipRouteTable; checkLeaderAlive?: () => Promise<boolean> },
): AppMembershipManager {
  const transport = new MockMembershipTransport(peers)
  const mm = new AppMembershipManager({
    nodeId,
    transport,
    onMembershipChange: () => {},
    routeTable: opts?.routeTable,
    checkLeaderAlive: opts?.checkLeaderAlive,
  })
  mm.start()
  return mm
}

describe('AppMembershipManager — safety', () => {
  test('should reject remove when cluster size <= 3', async () => {
    const mm = createManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
      { nodeId: 'node-3', addr: 'tcp://n3:7001' },
    ])

    await expect(mm.proposeChange('remove', 'node-2')).rejects.toThrow(
      /Cannot remove.*cluster size.*3/,
    )
    expect(mm.getMembers()).toEqual(['node-1', 'node-2', 'node-3'])
  })

  test('should reject on leader not alive during remove', async () => {
    const mm = createManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
      { nodeId: 'node-3', addr: 'tcp://n3:7001' },
      { nodeId: 'node-4', addr: 'tcp://n4:7001' },
    ], { checkLeaderAlive: async () => false })

    await expect(mm.proposeChange('remove', 'node-4')).rejects.toThrow(
      /leader election or partition/,
    )
  })

  test('should allow remove when leader is alive and cluster > 3', async () => {
    const transport = new MockMembershipTransport([
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
      { nodeId: 'node-3', addr: 'tcp://n3:7001' },
      { nodeId: 'node-4', addr: 'tcp://n4:7001' },
    ])

    const mm = new AppMembershipManager({
      nodeId: 'node-1',
      transport,
      onMembershipChange: () => {},
      checkLeaderAlive: async () => true,
      ackTimeoutMs: 10000,
    })
    mm.start()

    // 模拟其他节点 ACK（需要多数派 3/4 = floor(4/2)+1 = 3）
    const promise = mm.proposeChange('remove', 'node-4')

    // 延迟注入 ACK 确保 _pending 已设置
    setTimeout(() => {
      transport.inject('node-2', { type: 'ack', seq: 0, configHash: 'node-1,node-2,node-3,node-4' })
      transport.inject('node-3', { type: 'ack', seq: 0, configHash: 'node-1,node-2,node-3,node-4' })
    }, 10)

    await promise
    expect(mm.getMembers()).toEqual(['node-1', 'node-2', 'node-3'])
  })

  test('should reject concurrent proposals', async () => {
    const transport = new MockMembershipTransport([
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
      { nodeId: 'node-3', addr: 'tcp://n3:7001' },
      { nodeId: 'node-4', addr: 'tcp://n4:7001' },
    ])

    const mm = new AppMembershipManager({
      nodeId: 'node-1',
      transport,
      onMembershipChange: () => {},
      ackTimeoutMs: 5000,
    })
    mm.start()

    // Start first proposal (will wait for ACKs)
    const p1 = mm.proposeChange('add', 'node-5').catch(() => {})

    // Second should reject immediately
    await expect(mm.proposeChange('add', 'node-6')).rejects.toThrow(
      /Concurrent membership change/,
    )

    // Clean up: inject ACKs to complete p1
    transport.inject('node-2', { type: 'ack', seq: 0 })
    transport.inject('node-3', { type: 'ack', seq: 0 })
    await p1
  })
})

describe('AppMembershipManager — routeTable', () => {
  test('should update route table on add', async () => {
    const routeTable = new MembershipRouteTable()
    routeTable.initialize([
      { nodeId: 'node-1', addr: 'tcp://n1:7001' },
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
      { nodeId: 'node-3', addr: 'tcp://n3:7001' },
    ])

    const transport = new MockMembershipTransport([
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
      { nodeId: 'node-3', addr: 'tcp://n3:7001' },
    ])

    const mm = new AppMembershipManager({
      nodeId: 'node-1',
      transport,
      onMembershipChange: () => {},
      routeTable,
      ackTimeoutMs: 10000,
    })
    mm.start()

    // node-5 不在现有 cluster 中，需要手动添加到 transport 以模拟地址
    // 注意：在真实场景中，新节点的地址需要通过外部机制（如 DNS/配置）获取
    // node-5 不在现有 cluster 中，需要在 transport 中注册地址
    // 模拟"从外部系统获取新节点地址"
    // 针对测试：手动在 commit 前让 transport.getPeers() 返回 node-5
    // 真实场景：AppMembershipManager 会通过 RouteSync 消息获取地址
    const originalGetPeers = transport.getPeers.bind(transport) as () => Array<{ nodeId: string; addr: string }>
    transport.getPeers = () => [...originalGetPeers(), { nodeId: 'node-5', addr: 'tcp://n5:7001' }]

    const promise = mm.proposeChange('add', 'node-5')

    // 延迟注入 ACK 确保 _pending 已设置
    setTimeout(() => {
      transport.inject('node-2', { type: 'ack', seq: 0 })
      transport.inject('node-3', { type: 'ack', seq: 0 })
    }, 10)

    await promise

    expect(mm.getMembers()).toContain('node-5')
    expect(mm.getMembers()).toHaveLength(4)
    // Route table should have the new node
    expect(routeTable.getAddr('node-5')).toBe('tcp://n5:7001')
  })

  test('should clean route table on remove', async () => {
    const routeTable = new MembershipRouteTable()
    routeTable.initialize([
      { nodeId: 'node-1', addr: 'tcp://n1:7001' },
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
      { nodeId: 'node-3', addr: 'tcp://n3:7001' },
      { nodeId: 'node-4', addr: 'tcp://n4:7001' },
    ])

    const transport = new MockMembershipTransport([
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
      { nodeId: 'node-3', addr: 'tcp://n3:7001' },
      { nodeId: 'node-4', addr: 'tcp://n4:7001' },
    ])

    const mm = new AppMembershipManager({
      nodeId: 'node-1',
      transport,
      onMembershipChange: () => {},
      routeTable,
      checkLeaderAlive: async () => true,
      ackTimeoutMs: 10000,
    })
    mm.start()

    const promise = mm.proposeChange('remove', 'node-4')

    // 延迟注入 ACK
    setTimeout(() => {
      transport.inject('node-2', { type: 'ack', seq: 0 })
      transport.inject('node-3', { type: 'ack', seq: 0 })
    }, 10)

    await promise

    expect(mm.getMembers()).not.toContain('node-4')
    expect(routeTable.getAddr('node-4')).toBeUndefined()
  })
})

describe('AppMembershipManager — basic', () => {
  test('should reject add self', () => {
    const mm = createManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
    ])
    expect(mm.proposeChange('add', 'node-1')).rejects.toThrow(/add self/)
  })

  test('should reject remove self', () => {
    const mm = createManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
    ])
    expect(mm.proposeChange('remove', 'node-1')).rejects.toThrow(/remove self/)
  })

  test('should be idempotent for already existing peer', async () => {
    const mm = createManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
    ])
    await expect(mm.proposeChange('add', 'node-2')).resolves.toBeUndefined()
    expect(mm.getMembers()).toEqual(['node-1', 'node-2'])
  })

  test('should be idempotent for non-existing peer on remove', async () => {
    const mm = createManager('node-1', [
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
    ])
    await expect(mm.proposeChange('remove', 'ghost-node')).resolves.toBeUndefined()
  })

  test('should reject propose before start', () => {
    const transport = new MockMembershipTransport([{ nodeId: 'node-2', addr: 'tcp://n2:7001' }])
    const mm = new AppMembershipManager({
      nodeId: 'node-1',
      transport,
      onMembershipChange: () => {},
    })
    // not started
    expect(mm.proposeChange('add', 'node-3')).rejects.toThrow(/not started/)
  })

  test('should complete add with majority ACK', async () => {
    const transport = new MockMembershipTransport([
      { nodeId: 'node-2', addr: 'tcp://n2:7001' },
      { nodeId: 'node-3', addr: 'tcp://n3:7001' },
    ])

    const mm = new AppMembershipManager({
      nodeId: 'node-1',
      transport,
      onMembershipChange: () => {},
      ackTimeoutMs: 10000,
    })
    mm.start()

    const promise = mm.proposeChange('add', 'node-3')

    // 延迟注入 ACK 确保 _pending 已设置
    setTimeout(() => {
      transport.inject('node-2', { type: 'ack', seq: 0 })
    }, 10)
    // node-1 self-ACK counts, node-2 ACK makes 2 = quorum

    await promise
    expect(mm.getMembers()).toContain('node-3')
  })
})
