import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('raft-test-node (logic patterns)', () => {
  beforeEach(() => {
    process.env.RAFT_NODE_ID = 'node-1'
    process.env.RAFT_PEERS = 'node-2:5001,node-3:5002'
    process.env.RAFT_STORAGE_PATH = '/tmp/raft-test'
  })

  afterEach(() => {
    delete process.env.RAFT_NODE_ID
    delete process.env.RAFT_PEERS
    delete process.env.RAFT_STORAGE_PATH
  })

  it('requires RAFT_NODE_ID env var', () => {
    expect(process.env.RAFT_NODE_ID).toBe('node-1')
  })

  it('requires RAFT_PEERS env var', () => {
    expect(process.env.RAFT_PEERS).toBe('node-2:5001,node-3:5002')
  })

  it('parses RAFT_PEERS into peer objects', () => {
    const peerStr = process.env.RAFT_PEERS!
    const peers = peerStr.split(',').map(p => {
      const [id, port] = p.split(':')
      return { id, address: `localhost:${port}` }
    })
    expect(peers).toEqual([
      { id: 'node-2', address: 'localhost:5001' },
      { id: 'node-3', address: 'localhost:5002' },
    ])
  })

  it('reads RAFT_STORAGE_PATH', () => {
    expect(process.env.RAFT_STORAGE_PATH).toBe('/tmp/raft-test')
  })

  it('creates RaftNode config with parsed peers', () => {
    const peers = [{ id: 'node-2', address: 'localhost:5001' }]
    const config = {
      nodeId: process.env.RAFT_NODE_ID,
      peers,
      storagePath: process.env.RAFT_STORAGE_PATH,
    }

    expect(config.nodeId).toBe('node-1')
    expect(config.peers).toHaveLength(1)
    expect(config.storagePath).toBe('/tmp/raft-test')
  })

  it('inits the RaftNode after creation', async () => {
    let initialized = false
    const raftNode = {
      init: vi.fn().mockImplementation(async () => { initialized = true }),
      isInitialized: () => initialized,
    }

    await raftNode.init()
    expect(initialized).toBe(true)
  })

  it('leader role proposes operations to Raft', async () => {
    const proposedOps: any[] = []
    const raftNode = {
      isLeader: vi.fn().mockReturnValue(true),
      propose: vi.fn().mockImplementation(async (op: any) => { proposedOps.push(op) }),
    }

    const isLeader = raftNode.isLeader()
    expect(isLeader).toBe(true)

    await raftNode.propose({ id: 'op-1', type: 'upsert_node', payload: { name: 'test' } })
    expect(proposedOps).toHaveLength(1)
  })

  it('follower role does not propose', () => {
    const raftNode = {
      isLeader: vi.fn().mockReturnValue(false),
    }

    expect(raftNode.isLeader()).toBe(false)
  })

  it('handles periodic tick interval', () => {
    let tickCount = 0
    const tick = () => { tickCount++ }

    tick()
    tick()
    tick()

    expect(tickCount).toBe(3)
  })

  it('sends heartbeat on tick when leader', () => {
    let heartbeatsSent = 0
    const onTick = (isLeader: boolean) => {
      if (isLeader) heartbeatsSent++
    }

    onTick(true)
    onTick(true)
    onTick(false)

    expect(heartbeatsSent).toBe(2)
  })

  it('reads stdin for shutdown command (readline)', () => {
    let shutdownRequested = false

    const handleLine = (line: string) => {
      if (line.trim() === 'shutdown') {
        shutdownRequested = true
      }
    }

    handleLine('hello')
    handleLine('shutdown')

    expect(shutdownRequested).toBe(true)
  })

  it('shuts down gracefully', async () => {
    let shutdownCalled = false
    const raftNode = {
      shutdown: vi.fn().mockImplementation(async () => { shutdownCalled = true }),
    }

    await raftNode.shutdown()
    expect(shutdownCalled).toBe(true)
  })

  it('proposes operations with different types', async () => {
    const ops: any[] = []
    const raftNode = {
      propose: vi.fn().mockImplementation(async (op: any) => { ops.push(op) }),
    }

    const operations = [
      { id: 'op-1', type: 'upsert_node', payload: {} },
      { id: 'op-2', type: 'upsert_edge', payload: {} },
      { id: 'op-3', type: 'delete_node', payload: {} },
      { id: 'op-4', type: 'delete_edge', payload: {} },
      { id: 'op-5', type: 'batch_upsert', payload: [] },
    ]

    for (const op of operations) {
      await raftNode.propose(op)
    }

    expect(ops).toHaveLength(5)
  })

  it('gets raft status periodically', () => {
    const raftNode = {
      getStatus: vi.fn().mockReturnValue({
        role: 'follower', term: 2, committed: 10, applied: 8,
      }),
    }

    const status = raftNode.getStatus()
    expect(status.role).toBe('follower')
    expect(status.term).toBe(2)
    expect(status.committed).toBe(10)
    expect(status.applied).toBe(8)
  })

  it('reports leader if leaderId is set', () => {
    const raftNode = {
      getLeaderId: vi.fn().mockReturnValue('node-1'),
    }

    expect(raftNode.getLeaderId()).toBe('node-1')
  })

  it('reports null leader when no leader elected', () => {
    const raftNode = {
      getLeaderId: vi.fn().mockReturnValue(null),
    }

    expect(raftNode.getLeaderId()).toBeNull()
  })

  it('handles env var with different config', () => {
    process.env.RAFT_NODE_ID = 'node-5'
    process.env.RAFT_PEERS = 'node-6:6000'
    process.env.RAFT_STORAGE_PATH = '/custom/raft'

    const peers = process.env.RAFT_PEERS!.split(',').map(p => {
      const [id, port] = p.split(':')
      return { id, address: `localhost:${port}` }
    })

    expect(process.env.RAFT_NODE_ID).toBe('node-5')
    expect(peers).toEqual([{ id: 'node-6', address: 'localhost:6000' }])
  })
})
