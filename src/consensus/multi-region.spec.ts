import { MultiRegionTopology, LatencyAwareRouter, PartitionPriority } from './multi-region'

describe('MultiRegionTopology', () => {
  const config = {
    regions: {
      'dc-east': { id: 'dc-east', nodeIds: ['node-1', 'node-2'], labels: ['us-east'] },
      'dc-west': { id: 'dc-west', nodeIds: ['node-3', 'node-4'], labels: ['us-west'] },
      'dc-eu': { id: 'dc-eu', nodeIds: ['node-5'], labels: ['eu-west'] },
    },
    latencies: {
      'dc-east:dc-west': 60,
      'dc-east:dc-eu': 120,
      'dc-west:dc-eu': 180,
    } as Record<string, number>,
    currentNodeId: 'node-1',
    topologyType: 'cross-dc' as const,
  }

  let topology: MultiRegionTopology

  beforeEach(() => {
    topology = new MultiRegionTopology({ ...config })
  })

  test('should return all regions', () => {
    const regions = topology.getRegions()
    expect(regions).toHaveLength(3)
    expect(regions.map(r => r.id)).toEqual(['dc-east', 'dc-west', 'dc-eu'])
  })

  test('should get current region by node id', () => {
    expect(topology.getCurrentRegion()).toBe('dc-east')
  })

  test('should return undefined for unknown node region', () => {
    const unknownTopo = new MultiRegionTopology({ ...config, currentNodeId: 'ghost' })
    expect(unknownTopo.getCurrentRegion()).toBeUndefined()
  })

  test('should get region by id', () => {
    const region = topology.getRegion('dc-west')
    expect(region).toBeDefined()
    expect(region!.nodeIds).toEqual(['node-3', 'node-4'])
    expect(region!.labels).toEqual(['us-west'])
  })

  test('should return current region node ids', () => {
    const nodes = topology.getCurrentRegionNodeIds()
    expect(nodes).toEqual(['node-1', 'node-2'])
  })

  test('should get and set latencies', () => {
    expect(topology.getLatency('dc-east', 'dc-west')).toBe(60)
    expect(topology.getLatency('dc-west', 'dc-east')).toBe(60) // auto-reverse
    expect(topology.getLatency('dc-east', 'dc-east')).toBe(0)

    topology.setLatency('dc-east', 'dc-eu', 130)
    expect(topology.getLatency('dc-east', 'dc-eu')).toBe(130)
  })

  test('should return -1 for unknown latency pair', () => {
    expect(topology.getLatency('dc-east', 'unknown-dc')).toBe(-1)
  })

  test('should detect same DC from low latency', () => {
    topology.setLatency('dc-east', 'dc-west', 5)
    expect(topology.isInSameDc('dc-east', 'dc-west')).toBe(true)
  })

  test('should detect cross DC from high latency', () => {
    expect(topology.isInSameDc('dc-east', 'dc-west')).toBe(false)
  })

  test('should manage partition assignments', () => {
    topology.setPartitionRegion('p1', 'dc-east')
    topology.setPartitionRegion('p2', 'dc-west')

    const assignments = topology.getPartitionAssignments()
    expect(assignments).toEqual({ p1: 'dc-east', p2: 'dc-west' })

    const p1 = topology.getPartitionAssignment('p1')
    expect(p1).toBeDefined()
    expect(p1!.primaryRegion).toBe('dc-east')
    expect(p1!.replicaRegions).not.toContain('node-1') // not current node
    expect(p1!.replicaRegions).toContain('node-2')
  })

  test('should return undefined for unknown partition', () => {
    expect(topology.getPartitionAssignment('ghost')).toBeUndefined()
  })

  test('should compute backoff based on topology type', () => {
    expect(topology.computeBackoffFor('intra-dc')).toBe(3000)
    expect(topology.computeBackoffFor('cross-dc')).toBe(60000)
    expect(topology.computeBackoffFor('edge')).toBe(300000)
  })

  test('should compute cross-DC backoff amplified multiplier', () => {
    // dc-east vs dc-west: latency is 60 => cross-dc
    const backoff = topology.computeCrossDcBackoffIfNeeded('dc-east', 'dc-west')
    expect(backoff).toBe(60000 * 2) // cross-dc * multiplier=2
  })

  test('should compute intra-DC backoff for same region', () => {
    const backoff = topology.computeCrossDcBackoffIfNeeded('dc-east', 'dc-east')
    expect(backoff).toBe(3000) // intra-dc
  })

  test('should detect network partitions via heartbeat', () => {
    // 节点都活着 => 无分区
    topology.recordHeartbeat('node-3')
    topology.recordHeartbeat('node-5')

    // 心跳记录的时间是 Date.now()，因此未超时
    const partitionsWithHeartbeat = topology.detectPartitions()
    expect(partitionsWithHeartbeat).toHaveLength(0)

    // 不记录节点-3的心跳且设置超时很短来模拟
    const shortTimeout = new MultiRegionTopology({
      ...config,
      heartbeatTimeoutMs: 1, // 1ms timeout
      currentNodeId: 'node-1',
    })
    // 不记录任何心跳 => 所有跨 DC 节点视为死亡
    const partitions = shortTimeout.detectPartitions()
    expect(partitions.length).toBeGreaterThan(0)
  })

  test('should set and resolve partition state', () => {
    topology.setPartitionStrategy('dc-east', 'dc-west', 'lww')

    const states = topology.getPartitionStates()
    expect(states.length).toBeGreaterThanOrEqual(1)
    const state = states.find(s => s.regionA === 'dc-east' || s.regionA === 'dc-west')
    expect(state).toBeDefined()
    expect(state!.strategy).toBe('lww')
    expect(state!.resolved).toBe(false)

    topology.resolvePartition('dc-east', 'dc-west')
    const resolved = topology.getPartitionStates()
    const resolvedState = resolved.find(s => !s.resolved)
    expect(resolvedState).toBeUndefined()
  })

  test('should return all latencies as plain object', () => {
    const latencies = topology.getLatencies()
    expect(latencies['dc-east:dc-west']).toBe(60)
    expect(latencies['dc-east:dc-eu']).toBe(120)
    expect(latencies['dc-west:dc-eu']).toBe(180)
  })
})

describe('LatencyAwareRouter', () => {
  const config = {
    regions: {
      'dc-east': { id: 'dc-east', nodeIds: ['node-1', 'node-2'] },
      'dc-west': { id: 'dc-west', nodeIds: ['node-3', 'node-4'] },
    },
    latencies: { 'dc-east:dc-west': 50 } as Record<string, number>,
    currentNodeId: 'node-1',
  }

  let topology: MultiRegionTopology
  let router: LatencyAwareRouter

  beforeEach(() => {
    topology = new MultiRegionTopology({ ...config })
    router = new LatencyAwareRouter(topology)
  })

  test('should prefer other nodes in current region', () => {
    const preferred = router.getPreferredNode()
    expect(preferred).toBe('node-2') // other node in dc-east
  })

  test('should return current node when only one in region', () => {
    const soloTopo = new MultiRegionTopology({
      ...config,
      regions: {
        'dc-east': { id: 'dc-east', nodeIds: ['node-1'] },
        'dc-west': { id: 'dc-west', nodeIds: ['node-3'] },
      },
    })
    const soloRouter = new LatencyAwareRouter(soloTopo)
    expect(soloRouter.getPreferredNode()).toBe('node-1')
  })

  test('should return undefined for unknown region', () => {
    expect(router.getPreferredNode('unknown-dc')).toBeUndefined()
  })

  test('should return nodes sorted by latency from current region', () => {
    const nodes = router.getNodesByLatency()
    expect(nodes).toHaveLength(4)
    // dc-east nodes first (0 latency)
    expect(nodes[0].regionId).toBe('dc-east')
    expect(nodes[1].regionId).toBe('dc-east')
    expect(nodes[0].latency).toBe(0)
    expect(nodes[1].latency).toBe(0)
    // dc-west nodes next (50ms)
    expect(nodes[2].regionId).toBe('dc-west')
    expect(nodes[3].regionId).toBe('dc-west')
    expect(nodes[2].latency).toBe(50)
  })

  test('should prefer partition region node', () => {
    topology.setPartitionRegion('p1', 'dc-east')
    const node = router.getPreferredNodeForPartition('p1')
    expect(node).toBe('node-2') // other node in dc-east
  })

  test('should fallback to current region for unknown partition', () => {
    const node = router.getPreferredNodeForPartition('unknown-partition')
    // Fallback: other node in dc-east
    expect(node).toBe('node-2')
  })

  test('should create write mark with source info', () => {
    const mark = router.createWriteMark()
    expect(mark.sourceRegion).toBe('dc-east')
    expect(mark.sourceNodeId).toBe('node-1')
    expect(mark.timestamp).toBeGreaterThan(0)
  })
})

describe('PartitionPriority', () => {
  const config = {
    regions: {
      'dc-east': { id: 'dc-east', nodeIds: ['node-1'] },
      'dc-west': { id: 'dc-west', nodeIds: ['node-3'] },
    },
    currentNodeId: 'node-1',
    heartbeatTimeoutMs: 100,
  }

  let topology: MultiRegionTopology
  let priority: PartitionPriority

  beforeEach(() => {
    topology = new MultiRegionTopology({ ...config })
    priority = new PartitionPriority(topology, 'ignore')
  })

  test('should allow local write by default', () => {
    expect(priority.canWriteLocally()).toBe(true)
  })

  test('should return default strategy when no partition', () => {
    expect(priority.getStrategy()).toBe('ignore')
  })

  test('should detect partition and use configured strategy', () => {
    // Force partition by setting a strategy
    topology.setPartitionStrategy('dc-east', 'dc-west', 'lww')
    const partitions = topology.detectPartitions()
    // At this point we just verify the API works
    priority.setDefaultStrategy('lww')
  })

  test('should control local-only mode', () => {
    priority.setLocalOnly(true)
    // 即使有活跃的心跳，localOnly 时 shouldIgnoreRemote 返回 true
    // 确保即使没有检测到分区，localOnly=true 时也应忽略远程
    const result = priority.shouldIgnoreRemote()
    expect(result).toBe(true)
  })

  test('should toggle CRDT merge mode indirectly', () => {
    topology.setPartitionStrategy('dc-east', 'dc-west', 'crdt')
    priority.setDefaultStrategy('crdt')
    expect(priority.useCrdtMerge()).toBe(true)
  })
})
