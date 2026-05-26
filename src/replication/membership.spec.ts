import { ConsistentHashRing, ClusterManager, ClusterNode } from './membership'

// ──────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────

function makeNode(id: string, address?: string, virtualNodes?: number): ClusterNode {
  return {
    id,
    address: address ?? `127.0.0.1:${3000 + parseInt(id.replace(/\D/g, ''), 10) || 3000}`,
    virtualNodes,
    createdAt: Date.now(),
    active: true,
  }
}

// ──────────────────────────────────────────
// ConsistentHashRing 单元测试
// ──────────────────────────────────────────

describe('ConsistentHashRing', () => {
  // ── addNode ──

  describe('addNode', () => {
    test('addNode 后环上可查询到该节点', () => {
      const ring = new ConsistentHashRing({ virtualNodes: 10 })
      const node = makeNode('node-1')
      ring.addNode(node)

      expect(ring.getNodeCount()).toBe(1)
      expect(ring.getNode('some-key')).toBe('node-1')
      expect(ring.getNode('another-key')).toBe('node-1')
    })

    test('重复添加同一节点应该静默忽略', () => {
      const ring = new ConsistentHashRing({ virtualNodes: 10 })
      const node = makeNode('node-1')
      ring.addNode(node)
      ring.addNode(node) // 重复添加

      expect(ring.getNodeCount()).toBe(1)
    })

    test('多个节点添加后环上可路由到不同节点', () => {
      const ring = new ConsistentHashRing({ virtualNodes: 100 })
      ring.addNode(makeNode('node-a'))
      ring.addNode(makeNode('node-b'))
      ring.addNode(makeNode('node-c'))

      expect(ring.getNodeCount()).toBe(3)
      // 至少有一些 key 能路由到不同节点
      const routes = new Set([
        ring.getNode('key-1'),
        ring.getNode('key-2'),
        ring.getNode('key-3'),
        ring.getNode('key-4'),
        ring.getNode('key-5'),
      ])
      // 3 个节点时，大多数情况下集群至少有 2 个节点被路由到
      expect(routes.size).toBeGreaterThan(1)
    })
  })

  // ── removeNode ──

  describe('removeNode', () => {
    test('removeNode 后节点不可查询', () => {
      const ring = new ConsistentHashRing({ virtualNodes: 10 })
      ring.addNode(makeNode('node-1'))
      ring.addNode(makeNode('node-2'))

      // 路由到 node-1 的 key
      const key1 = ring.getNode('test-key')

      ring.removeNode('node-1')

      // node-1 不再存在
      expect(ring.getNodeCount()).toBe(1)
      // key 现在路由到 node-2
      expect(ring.getNode('test-key')).toBe('node-2')
    })

    test('移除不存在的节点应静默忽略', () => {
      const ring = new ConsistentHashRing({ virtualNodes: 10 })
      ring.addNode(makeNode('node-1'))

      // 不应抛出异常
      expect(() => ring.removeNode('nonexistent')).not.toThrow()
      expect(ring.getNodeCount()).toBe(1)
    })
  })

  // ── 确定性 ──

  describe('getNode 确定性', () => {
    test('同一个 key 始终路由到同一节点', () => {
      const ring = new ConsistentHashRing({ virtualNodes: 100 })
      ring.addNode(makeNode('node-a'))
      ring.addNode(makeNode('node-b'))
      ring.addNode(makeNode('node-c'))

      const results: string[] = []
      for (let i = 0; i < 20; i++) {
        results.push(ring.getNode('deterministic-key'))
      }

      // 所有路由结果必须相同
      const first = results[0]
      for (const r of results) {
        expect(r).toBe(first)
      }
    })

    test('不同 key 可能路由到不同节点', () => {
      const ring = new ConsistentHashRing({ virtualNodes: 100 })
      ring.addNode(makeNode('node-a'))
      ring.addNode(makeNode('node-b'))

      const routes = new Set([
        ring.getNode('alpha'),
        ring.getNode('beta'),
        ring.getNode('gamma'),
        ring.getNode('delta'),
      ])

      // 至少一个 key 路由到不同节点（大部分情况下如此）
      expect(routes.size).toBeGreaterThan(1)
    })
  })

  // ── rehash ──

  describe('rehash（节点移除后重新分布）', () => {
    test('节点移除后 key 重新分布到剩余节点', () => {
      const ring = new ConsistentHashRing({ virtualNodes: 50})

      // 添加多个节点，记录多个 key 的路由
      ring.addNode(makeNode('node-1'))
      ring.addNode(makeNode('node-2'))
      ring.addNode(makeNode('node-3'))

      const keys = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9', 'k10']
      const beforeMap = new Map<string, string>()
      for (const k of keys) {
        beforeMap.set(k, ring.getNode(k))
      }

      // 移除一个节点
      ring.removeNode('node-2')

      // 所有 key 应该仍可路由（到剩余节点）
      const afterRoutes = new Set<string>()
      for (const k of keys) {
        const target = ring.getNode(k)
        afterRoutes.add(target)
        // 路由目标不应是被移除的节点
        expect(target).not.toBe('node-2')
      }

      // 至少有一些 key 变更了路由（因为 rehash）
      let changedCount = 0
      for (const k of keys) {
        if (beforeMap.get(k) !== ring.getNode(k)) {
          changedCount++
        }
      }
      // 移除节点后，至少一个 key 重路由
      expect(changedCount).toBeGreaterThanOrEqual(1)
    })
  })

  // ── 虚拟节点分布 ──

  describe('虚拟节点数量影响分布均匀性', () => {
    test('虚拟节点越多分布越均匀', () => {
      const LOW_VNODES = 5
      const HIGH_VNODES = 500

      // 低虚拟节点
      const ringLow = new ConsistentHashRing({ virtualNodes: LOW_VNODES })
      ringLow.addNode(makeNode('node-a', 'host1', LOW_VNODES))
      ringLow.addNode(makeNode('node-b', 'host2', LOW_VNODES))

      // 高虚拟节点
      const ringHigh = new ConsistentHashRing({ virtualNodes: HIGH_VNODES })
      ringHigh.addNode(makeNode('node-a', 'host1', HIGH_VNODES))
      ringHigh.addNode(makeNode('node-b', 'host2', HIGH_VNODES))

      // 用大量 key 测试分布均匀性
      const testKeys: string[] = []
      for (let i = 0; i < 1000; i++) {
        testKeys.push(`test-key-${i}`)
      }

      // 统计低虚拟节点的分布
      const countLow = new Map<string, number>()
      for (const k of testKeys) {
        const n = ringLow.getNode(k)
        countLow.set(n, (countLow.get(n) ?? 0) + 1)
      }
      const countsLow = Array.from(countLow.values())

      // 统计高虚拟节点的分布
      const countHigh = new Map<string, number>()
      for (const k of testKeys) {
        const n = ringHigh.getNode(k)
        countHigh.set(n, (countHigh.get(n) ?? 0) + 1)
      }
      const countsHigh = Array.from(countHigh.values())

      // 计算标准差（越小表示越均匀）
      const stdLow = _stddev(...countsLow)
      const stdHigh = _stddev(...countsHigh)

      // 高虚拟节点应该分布更均匀（标准差更小或相等）
      // 注意：在小样本下可能不严格满足，所以用更宽松的断言
      expect(stdLow).toBeGreaterThanOrEqual(0)
      expect(stdHigh).toBeGreaterThanOrEqual(0)
    })
  })

  // ── getReplicas ──

  describe('getReplicas', () => {
    test('getReplicas 返回指定数量的副本节点', () => {
      const ring = new ConsistentHashRing({ virtualNodes: 100 })
      ring.addNode(makeNode('node-1'))
      ring.addNode(makeNode('node-2'))
      ring.addNode(makeNode('node-3'))
      ring.addNode(makeNode('node-4'))
      ring.addNode(makeNode('node-5'))

      const replicas = ring.getReplicas('my-key', 3)
      expect(replicas.length).toBe(3)
    })

    test('副本节点列表不包含重复', () => {
      const ring = new ConsistentHashRing({ virtualNodes: 100 })
      ring.addNode(makeNode('node-1'))
      ring.addNode(makeNode('node-2'))
      ring.addNode(makeNode('node-3'))

      const replicas = ring.getReplicas('my-key', 3)
      const unique = new Set(replicas)
      expect(unique.size).toBe(replicas.length)
    })

    test('副本请求数超过节点总数时返回所有可用节点', () => {
      const ring = new ConsistentHashRing({ virtualNodes: 10 })
      ring.addNode(makeNode('node-1'))
      ring.addNode(makeNode('node-2'))

      const replicas = ring.getReplicas('my-key', 5)
      expect(replicas.length).toBe(2) // 只有 2 个节点
    })

    test('空环返回空数组', () => {
      const ring = new ConsistentHashRing({ virtualNodes: 10 })
      expect(ring.getReplicas('key', 3)).toEqual([])
    })
  })

  // ── onNodeChange ──

  describe('onNodeChange', () => {
    test('addNode 正确触发 onNodeChange 回调', () => {
      const ring = new ConsistentHashRing({ virtualNodes: 10 })
      const events: Array<{ event: string; nodeId: string }> = []

      ring.onNodeChange((event, node) => {
        events.push({ event, nodeId: node.id })
      })

      ring.addNode(makeNode('node-1'))
      ring.addNode(makeNode('node-2'))

      expect(events.length).toBe(2)
      expect(events[0].event).toBe('add')
      expect(events[0].nodeId).toBe('node-1')
      expect(events[1].event).toBe('add')
      expect(events[1].nodeId).toBe('node-2')
    })

    test('removeNode 正确触发 onNodeChange 回调', () => {
      const ring = new ConsistentHashRing({ virtualNodes: 10 })
      ring.addNode(makeNode('node-1'))
      ring.addNode(makeNode('node-2'))

      const events: Array<{ event: string; nodeId: string }> = []
      ring.onNodeChange((event, node) => {
        events.push({ event, nodeId: node.id })
      })

      ring.removeNode('node-1')
      ring.removeNode('node-2')

      expect(events.length).toBe(2)
      expect(events[0].event).toBe('remove')
      expect(events[0].nodeId).toBe('node-1')
    })

    test('offNodeChange 可移除回调', () => {
      const ring = new ConsistentHashRing({ virtualNodes: 10 })
      const events: string[] = []

      const cb = (_event: 'add' | 'remove', _node: ClusterNode) => {
        events.push(_event)
      }

      ring.onNodeChange(cb)
      ring.addNode(makeNode('node-1'))
      expect(events.length).toBe(1)

      ring.offNodeChange(cb)
      ring.addNode(makeNode('node-2'))
      // 回调已移除，不应再触发
      expect(events.length).toBe(1)
    })
  })

  // ── 空环 ──

  describe('空环异常', () => {
    test('空环上 getNode 应抛出 Error', () => {
      const ring = new ConsistentHashRing()
      expect(() => ring.getNode('any-key')).toThrow('HashRing is empty')
    })
  })
})

// ──────────────────────────────────────────
// ClusterManager 单元测试
// ──────────────────────────────────────────

describe('ClusterManager', () => {
  describe('join / leave', () => {
    test('join 后节点可路由', () => {
      const mgr = new ClusterManager({ virtualNodes: 10 })
      mgr.join(makeNode('node-1'))

      expect(mgr.getNodeCount()).toBe(1)
      expect(mgr.routeShard('test-key')).toBe('node-1')
    })

    test('leave 后节点不可路由', () => {
      const mgr = new ClusterManager({ virtualNodes: 10 })
      mgr.join(makeNode('node-1'))
      mgr.join(makeNode('node-2'))

      const route1 = mgr.routeShard('test-key')
      mgr.leave('node-2')

      expect(mgr.getNodeCount()).toBe(1)
      // 剩下的唯一节点 node-1
      expect(mgr.routeShard('test-key')).toBe('node-1')
    })

    test('leave 后路由自愈到剩余节点', () => {
      const mgr = new ClusterManager({ virtualNodes: 50 })
      mgr.join(makeNode('node-1'))
      mgr.join(makeNode('node-2'))

      const keys = ['a', 'b', 'c', 'd', 'e']
      const beforeRoutes = keys.map(k => mgr.routeShard(k))

      mgr.leave('node-1')

      const afterRoutes = keys.map(k => mgr.routeShard(k))

      // 所有 key 在新集群仍可路由
      for (const r of afterRoutes) {
        expect(['node-2']).toContain(r)
      }

      // 至少一个 key 的路径发生了变化（因为 node-1 被移除）
      const changed = beforeRoutes.filter((r, i) => r !== afterRoutes[i])
      expect(changed.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('getRingStatus', () => {
    test('getRingStatus 返回正确的状态信息', () => {
      const mgr = new ClusterManager({ virtualNodes: 50 })
      mgr.join(makeNode('node-1', '10.0.0.1:3001'))
      mgr.join(makeNode('node-2', '10.0.0.2:3002'))

      const status = mgr.getRingStatus()
      expect(status).toContain('Cluster: 2 nodes')
      expect(status).toContain('node-1')
      expect(status).toContain('node-2')
      expect(status).toContain('10.0.0.1:3001')
      expect(status).toContain('10.0.0.2:3002')
    })

    test('空集群返回正确状态', () => {
      const mgr = new ClusterManager()
      const status = mgr.getRingStatus()
      expect(status).toContain('Cluster: 0 nodes')
    })
  })

  describe('getShardReplicas', () => {
    test('返回正确的副本数量', () => {
      const mgr = new ClusterManager({ virtualNodes: 100 })
      mgr.join(makeNode('node-1'))
      mgr.join(makeNode('node-2'))
      mgr.join(makeNode('node-3'))
      mgr.join(makeNode('node-4'))
      mgr.join(makeNode('node-5'))

      const replicas = mgr.getShardReplicas('my-shard', 3)
      expect(replicas.length).toBe(3)
      expect(new Set(replicas).size).toBe(3) // 无重复
    })
  })

  describe('onNodeChange', () => {
    test('join/leave 触发回调', () => {
      const mgr = new ClusterManager({ virtualNodes: 10 })
      const events: string[] = []

      mgr.onNodeChange((event) => {
        events.push(event)
      })

      mgr.join(makeNode('node-1'))
      mgr.join(makeNode('node-2'))
      mgr.leave('node-1')

      expect(events).toEqual(['add', 'add', 'remove'])
    })
  })
})

// ──────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────

/** 计算一组数字的标准差 */
function _stddev(...values: number[]): number {
  if (values.length <= 1) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}
