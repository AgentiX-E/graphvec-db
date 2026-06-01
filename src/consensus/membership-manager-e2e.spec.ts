/**
 * membership-manager-e2e.spec.ts — 3 节点端到端集成测试
 *
 * 使用 MeshTransport 连接 3 个 AppMembershipManager 实例，
 * 模拟真实网络拓扑下的成员变更流程。
 *
 * 覆盖：
 * - 3 节点 ±1 的 add/remove 正常流程
 * - RouteTable 自动更新
 * - syncCheck/preSyncCheck 集成
 * - 网络延迟下的正确性
 * - Leader 存活检查
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
import {
  AppMembershipManager,
  MembershipTransport,
  MembershipMessage,
} from './app-membership-manager'
import { MembershipRouteTable } from './membership-route-table'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ── MeshTransport：连接多个节点的模拟传输层 ──────────────────────

class MeshTransport implements MembershipTransport {
  private _nodeId: string
  private _peers: Array<{ nodeId: string; addr: string }>
  private _listeners: Array<(from: string, msg: any) => void> = []
  /** 所有 MeshTransport 实例的共享路由表 */
  private static _instances: Map<string, MeshTransport> = new Map()
  /** 模拟网络延迟（ms） */
  public static networkDelayMs = 0

  constructor(nodeId: string, peers: Array<{ nodeId: string; addr: string }>) {
    this._nodeId = nodeId
    this._peers = peers
    MeshTransport._instances.set(nodeId, this)
  }

  async send(peerId: string, msg: any): Promise<void> {
    const target = MeshTransport._instances.get(peerId)
    if (!target) return
    if (MeshTransport.networkDelayMs > 0) {
      await sleep(MeshTransport.networkDelayMs)
    }
    for (const listener of target._listeners) {
      listener(this._nodeId, msg)
    }
  }

  async broadcast(msg: any): Promise<void> {
    for (const peer of this._peers) {
      const target = MeshTransport._instances.get(peer.nodeId)
      if (!target) continue
      for (const listener of target._listeners) {
        listener(this._nodeId, msg)
      }
    }
  }

  onMessage(cb: (from: string, msg: any) => void): void {
    this._listeners.push(cb)
  }

  getPeers(): Array<{ nodeId: string; addr: string }> {
    // 从 _instances 获取所有已注册节点
    const all: Array<{ nodeId: string; addr: string }> = [...this._peers]
    for (const [nid] of MeshTransport._instances) {
      if (nid !== this._nodeId && !all.find(p => p.nodeId === nid)) {
        all.push({ nodeId: nid, addr: `tcp://${nid}:7001` })
      }
    }
    return all
  }

  static destroy(): void {
    MeshTransport._instances.clear()
    MeshTransport.networkDelayMs = 0
  }

  /** 注册外部 peer（用于 RouteTable 测试） */
  static registerPeer(nodeId: string, addr: string): void {
    const inst = MeshTransport._instances.get(nodeId)
    if (!inst) {
      // 创建一个空的 peer（nodeId 不在集群中，仅用于路由注册）
      MeshTransport._instances.set(nodeId, new MeshTransport(nodeId, []))
    }
  }
}

/** 创建 3 节点集群 */
function createCluster(opts?: {
  syncCheck?: () => Promise<boolean>
  preSyncCheck?: (peerId: string) => Promise<boolean>
  checkLeaderAlive?: () => Promise<boolean>
  routeTable?: boolean
  ackTimeoutMs?: number
}): {
  managers: AppMembershipManager[]
  routeTables: MembershipRouteTable[]
} {
  MeshTransport.destroy()

  const nodeIds = ['node-1', 'node-2', 'node-3']
  const peers = nodeIds.map(id => ({ nodeId: id, addr: `tcp://${id}:7001` }))
  const transports = nodeIds.map(id => new MeshTransport(id, peers.filter(p => p.nodeId !== id)))
  const managers: AppMembershipManager[] = []
  const routeTables: MembershipRouteTable[] = []

  for (let i = 0; i < 3; i++) {
    const routeTable = opts?.routeTable !== false ? new MembershipRouteTable() : undefined
    if (routeTable) routeTables.push(routeTable)

    const mm = new AppMembershipManager({
      nodeId: nodeIds[i],
      transport: transports[i],
      onMembershipChange: () => {},
      ackTimeoutMs: opts?.ackTimeoutMs ?? 5000,
      routeTable,
      checkLeaderAlive: opts?.checkLeaderAlive,
      syncCheck: opts?.syncCheck,
      preSyncCheck: opts?.preSyncCheck,
    })
    mm.start()
    managers.push(mm)
  }

  return { managers, routeTables }
}

describe('MembershipManager — 3 节点端到端', { timeout: 30000 }, () => {
  beforeEach(() => {
    MeshTransport.destroy()
  })

  test('3 节点初始状态正确', () => {
    const { managers } = createCluster()
    for (const mm of managers) {
      expect(mm.getMembers()).toEqual(['node-1', 'node-2', 'node-3'])
    }
  })

  test('add node-4 在所有节点一致', async () => {
    const { managers } = createCluster()

    // node-1 发起 add，广播到所有节点
    await managers[0].proposeChange('add', 'node-4')

    // 所有节点最终一致
    for (const mm of managers) {
      expect(mm.getMembers()).toContain('node-4')
      expect(mm.getMembers().length).toBe(4)
    }
  })

  test('remove node-4 在所有节点一致', async () => {
    const { managers } = createCluster()

    await managers[0].proposeChange('add', 'node-4')
    // 从 4 节点移除 node-4
    await managers[1].proposeChange('remove', 'node-4')

    for (const mm of managers) {
      expect(mm.getMembers()).not.toContain('node-4')
      expect(mm.getMembers().length).toBe(3)
    }
  })

  test('任意节点可以发起成员变更', async () => {
    const { managers } = createCluster()

    await managers[1].proposeChange('add', 'node-5')
    for (const mm of managers) {
      expect(mm.getMembers()).toContain('node-5')
    }

    await managers[2].proposeChange('add', 'node-6')
    for (const mm of managers) {
      expect(mm.getMembers()).toContain('node-6')
    }
  })

  test('重复 add 幂等', async () => {
    const { managers } = createCluster()

    await managers[0].proposeChange('add', 'node-4')
    // 另一个节点也尝试 add 同一个节点（幂等）
    await managers[1].proposeChange('add', 'node-4')

    for (const mm of managers) {
      expect(mm.getMembers()).toContain('node-4')
    }
  })

  test('3 节点时不能 remove（安全保护）', async () => {
    const { managers } = createCluster()

    await expect(
      managers[0].proposeChange('remove', 'node-2')
    ).rejects.toThrow(/Cannot remove/)
  })

  test('add → remove → re-add 完整周期（commit 传播）', async () => {
    const { managers } = createCluster()

    // add → 4 节点
    await managers[0].proposeChange('add', 'node-7')
    for (const mm of managers) {
      expect(mm.getMembers()).toContain('node-7')
    }

    // remove → 3 节点
    await managers[1].proposeChange('remove', 'node-7')
    for (const mm of managers) {
      expect(mm.getMembers()).not.toContain('node-7')
    }

    // re-add → 4 节点
    await managers[2].proposeChange('add', 'node-7')
    for (const mm of managers) {
      expect(mm.getMembers()).toContain('node-7')
    }
  })

  test('RouteTable 自动更新', async () => {
    const { managers, routeTables } = createCluster({ routeTable: true })

    // node-4 的路由信息（通过 transport 可见）
    MeshTransport.registerPeer('node-4', 'tcp://node-4:7001')

    await managers[0].proposeChange('add', 'node-4')

    // 所有节点的路由表应有 node-4
    for (const rt of routeTables) {
      const addr = rt.getAddr('node-4')
      expect(addr).toBeDefined()
      expect(addr).toBe('tcp://node-4:7001')
    }
  })

  test('Leader 存活检查：拒绝离线 Leader 的变更', async () => {
    let aliveCalls = 0
    const { managers } = createCluster({
      checkLeaderAlive: async () => {
        aliveCalls++
        if (aliveCalls === 1) return true
        return false // 第二次调用返回 false
      },
    })

    // node-1 发起 add（leader 存活）
    await managers[0].proposeChange('add', 'node-4')

    // node-1 再次发起（leader 不存活 → 拒绝）
    await expect(
      managers[0].proposeChange('add', 'node-5')
    ).rejects.toThrow(/leader|election|partition/i)
  })

  test('syncCheck 在 commit 前被调用', async () => {
    const syncCallLog: string[] = []
    const { managers } = createCluster({
      syncCheck: async () => {
        syncCallLog.push('syncCheck called')
        return true
      },
    })

    await managers[0].proposeChange('add', 'node-4')
    expect(syncCallLog.length).toBeGreaterThanOrEqual(1)
  })

  test('syncCheck 返回 false 则变更回滚（所有节点一致）', async () => {
    const { managers } = createCluster({
      // 只有 node-1 的 syncCheck 返回 false（作为发起者）
      syncCheck: async () => false,
    })

    await expect(
      managers[0].proposeChange('add', 'node-4')
    ).rejects.toThrow(/syncCheck/)

    // 所有节点没有 node-4（commit 没有被广播）
    for (const mm of managers) {
      expect(mm.getMembers()).not.toContain('node-4')
    }
  })

  test('preSyncCheck 在提案前被调用', async () => {
    const preSyncLog: string[] = []
    const { managers } = createCluster({
      preSyncCheck: async (peerId: string) => {
        preSyncLog.push(`preSyncCheck(${peerId})`)
        return true
      },
    })

    await managers[0].proposeChange('add', 'node-10')
    expect(preSyncLog).toContain('preSyncCheck(node-10)')
  })

  test('preSyncCheck 返回 false 则提案被拒绝', async () => {
    const { managers } = createCluster({
      preSyncCheck: async () => false,
    })

    await expect(
      managers[0].proposeChange('add', 'node-10')
    ).rejects.toThrow(/PreSync/)

    // 没有 commit 广播，所有节点不变
    for (const mm of managers) {
      expect(mm.getMembers()).toEqual(['node-1', 'node-2', 'node-3'])
    }
  })

  test('网络延迟下的成员变更一致性', async () => {
    MeshTransport.networkDelayMs = 50 // 50ms 延迟
    const { managers } = createCluster({ ackTimeoutMs: 10000 })

    await managers[0].proposeChange('add', 'node-8')
    for (const mm of managers) {
      expect(mm.getMembers()).toContain('node-8')
    }

    await managers[1].proposeChange('add', 'node-9')
    for (const mm of managers) {
      expect(mm.getMembers()).toContain('node-9')
    }
  })

  test('并发 add 请求被拒绝', async () => {
    const { managers } = createCluster()

    // node-1 正在提案中，node-2 并发提案应被拒绝
    const p1 = managers[0].proposeChange('add', 'node-4')
    await expect(
      managers[0].proposeChange('add', 'node-5')
    ).rejects.toThrow(/Concurrent/)
    await p1

    // 但其他节点的 proposeChange 不受影响（每个节点独立管理器）
    // 验证 node-4 最终被添加
    for (const mm of managers) {
      expect(mm.getMembers()).toContain('node-4')
    }
  })
})

// 扩展 MeshTransport 的能力
declare module './membership-manager-e2e.spec' {
  // 注册额外 peer（用于 RouteTable 测试）
}
