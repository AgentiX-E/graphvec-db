/**
 * R7: Topology-aware Outbox backoff — Integration Test
 *
 * Validates that MultiLeaderReplication derives maxBackoffSeconds from topology:
 *   - intra-dc → 3s
 *   - cross-dc → 60s (default)
 *   - edge → 300s
 *   - explicit maxBackoffSeconds overrides topology
 */

import { MultiLeaderReplication, type TopologyType } from '../../src/core/multi-leader-replication'
import * as path from 'node:path'
import * as fs from 'node:fs'

// A minimal EventBus stub that satisfies the config interface
function createStubEventBus(nodeId: string) {
  return {
    send: async (_peerId: string, _msg: any) => {},
  }
}

describe('R7: Topology-aware Outbox backoff', () => {
  const baseDir = path.join('/tmp', `agentiX-topo-backoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

  let cleanupDirs: string[] = []

  beforeAll(() => {
    fs.mkdirSync(baseDir, { recursive: true })
  })

  afterAll(() => {
    for (const dir of cleanupDirs) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    fs.rmSync(baseDir, { recursive: true, force: true })
  })

  function makeDbPath(label: string): string {
    const dir = path.join(baseDir, label)
    fs.mkdirSync(dir, { recursive: true })
    cleanupDirs.push(dir)
    return dir
  }

  const commonPeers = [
    { nodeId: 'node-a', addr: 'inproc://a' },
    { nodeId: 'node-b', addr: 'inproc://b' },
  ]

  it('intra-dc topology resolves to maxBackoffSeconds = 3', async () => {
    const ml = new MultiLeaderReplication({
      nodeId: 'node-a',
      peers: commonPeers,
      curveDir: baseDir,
      dbPath: makeDbPath('intra-dc'),
      topology: 'intra-dc',
      eventBus: createStubEventBus('node-a'),
    })
    try {
      expect(ml.getConfig().maxBackoffSeconds).toBe(3)
    } finally {
      ml.stop()
    }
  })

  it('cross-dc topology resolves to maxBackoffSeconds = 60', async () => {
    const ml = new MultiLeaderReplication({
      nodeId: 'node-a',
      peers: commonPeers,
      curveDir: baseDir,
      dbPath: makeDbPath('cross-dc'),
      topology: 'cross-dc',
      eventBus: createStubEventBus('node-a'),
    })
    try {
      expect(ml.getConfig().maxBackoffSeconds).toBe(60)
    } finally {
      ml.stop()
    }
  })

  it('edge topology resolves to maxBackoffSeconds = 300', async () => {
    const ml = new MultiLeaderReplication({
      nodeId: 'node-a',
      peers: commonPeers,
      curveDir: baseDir,
      dbPath: makeDbPath('edge'),
      topology: 'edge',
      eventBus: createStubEventBus('node-a'),
    })
    try {
      expect(ml.getConfig().maxBackoffSeconds).toBe(300)
    } finally {
      ml.stop()
    }
  })

  it('default topology (no topology field) is cross-dc = 60', async () => {
    const ml = new MultiLeaderReplication({
      nodeId: 'node-a',
      peers: commonPeers,
      curveDir: baseDir,
      dbPath: makeDbPath('default'),
      eventBus: createStubEventBus('node-a'),
    })
    try {
      expect(ml.getConfig().maxBackoffSeconds).toBe(60)
    } finally {
      ml.stop()
    }
  })

  it('explicit maxBackoffSeconds overrides topology default', async () => {
    const ml = new MultiLeaderReplication({
      nodeId: 'node-a',
      peers: commonPeers,
      curveDir: baseDir,
      dbPath: makeDbPath('override'),
      topology: 'intra-dc',
      maxBackoffSeconds: 99,
      eventBus: createStubEventBus('node-a'),
    })
    try {
      // Explicit 99 should override the intra-dc default of 3
      expect(ml.getConfig().maxBackoffSeconds).toBe(99)
    } finally {
      ml.stop()
    }
  })

  it('all three topology types produce distinct values', async () => {
    const topologies: TopologyType[] = ['intra-dc', 'cross-dc', 'edge']
    const expected = [3, 60, 300]
    const instances = topologies.map((t, i) => {
      const ml = new MultiLeaderReplication({
        nodeId: 'node-a',
        peers: commonPeers,
        curveDir: baseDir,
        dbPath: makeDbPath(`distinct-${t}`),
        topology: t,
        eventBus: createStubEventBus('node-a'),
      })
      expect(ml.getConfig().maxBackoffSeconds).toBe(expected[i])
      return ml
    })
    // Verify all three are different from each other
    const values = instances.map(ml => ml.getConfig().maxBackoffSeconds)
    expect(new Set(values).size).toBe(3)
    // Cleanup
    for (const ml of instances) {
      ml.stop()
    }
  })
})
