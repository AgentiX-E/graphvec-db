/**
 * raft-install-snapshot.spec.ts — InstallSnapshot R04 集成测试
 *
 * 测试场景：
 * 1. Leader → Follower InstallSnapshot 推送
 * 2. Follower 接收并恢复数据校验
 * 3. Checksum 篡改拒绝
 */
import { RaftLogicConsensus } from './raft-logic-consensus'
import { ConsensusConfig } from './consensus-provider'
import { MockTransport, InstallSnapshotRequest, InstallSnapshotResponse, Transport } from './transport'

// ─── Mock Raft Module ──────────────────────────────────────────

interface SnapshotCallback {
  (snapshotBase64: string): void
}

interface MockNodeStatus {
  role: string
  leaderId: string | null
  term: number
  committed: number
  applied: number
}

/**
 * 精简版 mock raft-logic module
 * 用于测试 InstallSnapshot 流程而非完整 raft
 */
function createMockRaftModule() {
  const nodes = new Map<number, {
    raftNode: any
    storage: { data: Map<string, string> }
  }>()

  return {
    InMemoryStorage: class {
      data = new Map<string, string>()
      async open() {}
      async close() {}
    },
    SqliteStorage: class {
      async open() {}
      async close() {}
    },
    InMemoryTransport: class {
      private onMsg: ((from: string, msg: Uint8Array) => void) | null = null
      async send(to: string | number, msg: Uint8Array) {
        // Transport messages directly via global registry
        this.onMsg?.(String(to), msg)
      }
      recv(onMessage: (from: string, msg: Uint8Array) => void) {
        this.onMsg = onMessage
      }
      async close() {}
      async flush() {}
    },
    RaftNode: class {
      public id: number
      public peers: number[]
      public storage: any
      private _status: MockNodeStatus
      private _onSnapshot: SnapshotCallback | null = null
      private _snapshotData: string | null = null
      public _appliedData: string[] = []
      public apply: (entry: any) => Promise<void>

      constructor(opts: any) {
        this.id = opts.id
        this.peers = opts.peers
        this.storage = opts.storage
        this._status = {
          role: this.id === 1 ? 'leader' : 'follower',
          leaderId: '1',
          term: 1,
          committed: 0,
          applied: 0,
        }
        this.apply = opts.apply
      }

      async start() {}
      async stop() {}
      async clientRequest(data: string, opts?: any): Promise<{ ok: boolean; data?: string }> {
        if (this.apply) {
          await this.apply({ index: 1, term: 1, data: Buffer.from(data, 'base64') })
        }
        return { ok: true }
      }
      async readIndex() {}
      async waitForLeaderStable() {}
      async barrier() {}
      status() { return this._status }
      async triggerSnapshot(opts?: { compact?: boolean }) {
        // Mock: 不需要真正 compact
      }

      // InstallSnapshot 支持
      onSnapshot(cb: SnapshotCallback) {
        this._onSnapshot = cb
      }

      _fireSnapshot(data: string) {
        if (this._onSnapshot) {
          this._onSnapshot(data)
        }
      }
    },
    ready: Promise.resolve(),
  }
}

// ─── 工具函数 ──────────────────────────────────────────────────

/** 创建简单的 Snapshot 数据用于测试 */
function createTestSnapshotData(size: number = 1024): Buffer {
  const data = Buffer.alloc(size)
  for (let i = 0; i < size; i++) {
    data[i] = i % 256
  }
  return data
}

/** 计算简单 checksum（CRC32-like） */
function computeChecksum(data: Buffer): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xEDB88320
      } else {
        crc = crc >>> 1
      }
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// ─── Tests ─────────────────────────────────────────────────────

describe('Raft InstallSnapshot (R04)', () => {

  describe('RaftLogicConsensus InstallSnapshot', () => {
    let consensus: RaftLogicConsensus
    let mockModule: any

    beforeAll(async () => {
      mockModule = createMockRaftModule()
    })

    afterEach(async () => {
      if (consensus) {
        try { await consensus.stop() } catch { /* ignore */ }
      }
    })

    it('should install snapshot on follower via handleInstallSnapshot', async () => {
      const config: ConsensusConfig = {
        mode: 'raft-logic',
        nodeId: '2',
        peers: ['1'],
      }

      const appliedData: string[] = []
      consensus = new RaftLogicConsensus(config, mockModule)

      consensus.setApply(async (data: Uint8Array) => {
        appliedData.push(Buffer.from(data).toString('utf-8'))
      })

      // Mock engine for import/export
      let savedSnapshot: Buffer | null = null
      const mockEngine = {
        exportSnapshot: () => savedSnapshot || Buffer.alloc(0),
        importSnapshot: (data: Buffer) => {
          savedSnapshot = data
        },
      }
      ;(consensus as any)._engine = mockEngine

      await consensus.start()

      // Create snapshot data
      const snapshotData = createTestSnapshotData(256)
      const request: InstallSnapshotRequest = {
        term: 1,
        leaderId: '1',
        lastIncludedIndex: 100,
        lastIncludedTerm: 1,
        data: snapshotData,
        done: true,
      }

      // Call handleInstallSnapshot (follower side)
      const response = await consensus.handleInstallSnapshot(request)

      expect(response.success).toBe(true)
      expect(response.term).toBe(1)

      // Verify snapshot was stored
      expect(savedSnapshot).toBeTruthy()
      expect(savedSnapshot!.length).toBeGreaterThan(0)
    })

    it('should install snapshot and update crash recovery metadata', async () => {
      const config: ConsensusConfig = {
        mode: 'raft-logic',
        nodeId: '2',
        peers: ['1'],
      }

      consensus = new RaftLogicConsensus(config, mockModule)

      let savedSnapshot: Buffer | null = null
      const mockEngine = {
        exportSnapshot: () => savedSnapshot || Buffer.alloc(0),
        importSnapshot: (data: Buffer) => {
          savedSnapshot = Buffer.from(data)
        },
      }
      ;(consensus as any)._engine = mockEngine

      // Register snapshot handler to track calls
      let handlerCalled = false
      consensus.setSnapshotHandler(async (data: Buffer) => {
        handlerCalled = true
      })

      await consensus.start()

      const snapshotData = createTestSnapshotData(256)
      const request: InstallSnapshotRequest = {
        term: 2,
        leaderId: '1',
        lastIncludedIndex: 150,
        lastIncludedTerm: 2,
        data: snapshotData,
        done: true,
      }

      const response = await consensus.handleInstallSnapshot(request)
      expect(response.success).toBe(true)

      // Verify crash recovery metadata was updated
      const metrics = consensus.getSnapshotMetrics()
      expect(metrics.count).toBe(1)
      expect(metrics.lastSize).toBe(256)
      expect(metrics.lastIndex).toBe(150)

      // Verify snapshot handler was called
      expect(handlerCalled).toBe(true)

      // Verify engine received the snapshot
      expect(savedSnapshot).toBeTruthy()
      expect(savedSnapshot!.length).toBe(256)
    })

    it('should trigger WASM onSnapshot callback when engine is updated', async () => {
      const config: ConsensusConfig = {
        mode: 'raft-logic',
        nodeId: '2',
        peers: ['1'],
      }

      consensus = new RaftLogicConsensus(config, mockModule)

      let engineSnapshot: Buffer | null = null
      const mockEngine = {
        exportSnapshot: () => engineSnapshot || Buffer.alloc(0),
        importSnapshot: (data: Buffer) => {
          engineSnapshot = Buffer.from(data)
        },
      }
      ;(consensus as any)._engine = mockEngine

      // Register snapshot handler
      let handlerData: Buffer | null = null
      consensus.setSnapshotHandler(async (data: Buffer) => {
        handlerData = Buffer.from(data)
      })

      await consensus.start()

      // Simulate WASM onSnapshot callback firing
      const snapshotData = createTestSnapshotData(128)
      const node = (consensus as any)._node
      expect(node).toBeTruthy()
      expect(typeof node._fireSnapshot).toBe('function')

      node._fireSnapshot(snapshotData.toString('base64'))

      // Small delay for async callback
      await new Promise(r => setTimeout(r, 10))

      // Verify snapshot handler received the data
      expect(handlerData).toBeTruthy()
      expect(handlerData!.length).toBe(128)

      // Verify engine also received the snapshot
      expect(engineSnapshot).toBeTruthy()
      expect(engineSnapshot!.length).toBe(128)
    })

    it('should fail handleInstallSnapshot on invalid data', async () => {
      const config: ConsensusConfig = {
        mode: 'raft-logic',
        nodeId: '2',
        peers: ['1'],
      }

      consensus = new RaftLogicConsensus(config, mockModule)
      consensus.setApply(async (data: Uint8Array) => {})

      // Mock engine that throws on import
      const mockEngine = {
        exportSnapshot: () => Buffer.alloc(0),
        importSnapshot: (data: Buffer) => {
          throw new Error('Corrupt snapshot data')
        },
      }
      ;(consensus as any)._engine = mockEngine

      await consensus.start()

      const request: InstallSnapshotRequest = {
        term: 1,
        leaderId: '1',
        lastIncludedIndex: 50,
        lastIncludedTerm: 1,
        data: Buffer.from('bad-data'),
        done: true,
      }

      const response = await consensus.handleInstallSnapshot(request)

      expect(response.success).toBe(false)
      expect(response.term).toBe(1)
    })
  })

  describe('MockTransport InstallSnapshot', () => {
    let leader: MockTransport
    let follower: MockTransport
    let followerConsensus: RaftLogicConsensus
    let mockModule: any

    beforeAll(() => {
      mockModule = createMockRaftModule()
    })

    beforeEach(async () => {
      MockTransport.reset()

      leader = new MockTransport('1')
      follower = new MockTransport('2')

      await leader.start()
      await follower.start()
    })

    afterEach(async () => {
      try { await leader?.stop() } catch { /* ignore */ }
      try { await follower?.stop() } catch { /* ignore */ }
      try { await followerConsensus?.stop() } catch { /* ignore */ }
      MockTransport.reset()
    })

    // Helper: register handlers so installSnapshot RPC works
    function registerMockHandlers() {
      // Leader registers listener for InstallSnapshotResponse
      leader.onMessage((from: string, msg: any) => {
        // Just acknowledge — in real flow, RaftCore dispatches
      })

      // Follower registers listener for InstallSnapshot
      follower.onMessage((from: string, msg: any) => {
        if (msg.type === 'InstallSnapshot' && msg.data) {
          const req = msg.data as InstallSnapshotRequest
          // Follower consensus handles it
          followerConsensus?.handleInstallSnapshot(req).then(resp => {
            // Send response back
            MockTransport.sendResponse('1', '2', {
              type: 'InstallSnapshotResponse',
              term: resp.term,
              from: '2',
              to: '1',
              data: resp,
            })
          })
        }
      })
    }

    it('should send and receive snapshot via MockTransport', async () => {
      // Setup follower consensus
      let followerSaved: Buffer | null = null
      const config: ConsensusConfig = {
        mode: 'raft-logic',
        nodeId: '2',
        peers: ['1'],
      }
      followerConsensus = new RaftLogicConsensus(config, mockModule)
      const followerEngine = {
        exportSnapshot: () => followerSaved || Buffer.alloc(0),
        importSnapshot: (data: Buffer) => { followerSaved = data },
      }
      ;(followerConsensus as any)._engine = followerEngine
      await followerConsensus.start()

      registerMockHandlers()

      // Create snapshot data from leader
      const snapshotData = createTestSnapshotData(512)
      const req: InstallSnapshotRequest = {
        term: 1,
        leaderId: '1',
        lastIncludedIndex: 200,
        lastIncludedTerm: 1,
        data: snapshotData,
        done: true,
      }

      // Leader sends InstallSnapshot via MockTransport
      const response = await leader.installSnapshot('2', req)

      expect(response.success).toBe(true)
      expect(response.term).toBe(1)

      // Check follower got the snapshot
      expect(followerSaved).toBeTruthy()
      expect(followerSaved!.length).toBe(512)
    })

    it('should reject corrupt snapshot via MockTransport', async () => {
      const config: ConsensusConfig = {
        mode: 'raft-logic',
        nodeId: '2',
        peers: ['1'],
      }
      followerConsensus = new RaftLogicConsensus(config, mockModule)
      const followerEngine = {
        exportSnapshot: () => Buffer.alloc(0),
        importSnapshot: (data: Buffer) => {
          throw new Error('Corrupt data')
        },
      }
      ;(followerConsensus as any)._engine = followerEngine
      await followerConsensus.start()

      registerMockHandlers()

      const snapshotData = Buffer.from('corrupted-data')
      const req: InstallSnapshotRequest = {
        term: 1,
        leaderId: '1',
        lastIncludedIndex: 50,
        lastIncludedTerm: 1,
        data: snapshotData,
        done: true,
      }

      const response = await leader.installSnapshot('2', req)

      expect(response.success).toBe(false)
    })
  })

  describe('Snapshot checksum validation', () => {
    it('should compute and verify checksum correctly', () => {
      const data = createTestSnapshotData(1024)
      const originalChecksum = computeChecksum(data)

      // Verify the same data produces the same checksum
      const verifyChecksum = computeChecksum(data)
      expect(verifyChecksum).toBe(originalChecksum)

      // Tamper with data
      const tamperedData = Buffer.from(data)
      tamperedData[42] = 0xFF
      const tamperedChecksum = computeChecksum(tamperedData)
      expect(tamperedChecksum).not.toBe(originalChecksum)
    })
  })

  describe('Leader→Follower full flow', () => {
    it('should complete InstallSnapshot round trip with data integrity', async () => {
      MockTransport.reset()

      const leaderTransport = new MockTransport('lead-1')
      const followerTransport = new MockTransport('foll-2')
      await leaderTransport.start()
      await followerTransport.start()

      const mockModule = createMockRaftModule()

      // Setup follower consensus with engine tracking
      let storedSnapshot: Buffer | null = null

      const followerConfig: ConsensusConfig = {
        mode: 'raft-logic',
        nodeId: 'foll-2',
        peers: ['lead-1'],
      }
      const followerConsensus = new RaftLogicConsensus(followerConfig, mockModule)
      const followerEngine = {
        exportSnapshot: () => storedSnapshot || Buffer.alloc(0),
        importSnapshot: (data: Buffer) => {
          storedSnapshot = Buffer.from(data)
        },
      }
      ;(followerConsensus as any)._engine = followerEngine
      await followerConsensus.start()

      // Register message handlers
      followerTransport.onMessage((from: string, msg: any) => {
        if (msg.type === 'InstallSnapshot') {
          const req = msg.data as InstallSnapshotRequest
          followerConsensus.handleInstallSnapshot(req).then(resp => {
            MockTransport.sendResponse(from, 'foll-2', {
              type: 'InstallSnapshotResponse',
              term: resp.term,
              from: 'foll-2',
              to: from,
              data: resp,
            })
          })
        }
      })

      // Create known snapshot data with a pattern
      const originalData = Buffer.alloc(1024)
      for (let i = 0; i < 1024; i++) {
        originalData[i] = (i * 7 + 31) % 256
      }

      // Leader pushes snapshot
      const req: InstallSnapshotRequest = {
        term: 2,
        leaderId: 'lead-1',
        lastIncludedIndex: 300,
        lastIncludedTerm: 2,
        data: originalData,
        done: true,
      }

      const response = await leaderTransport.installSnapshot('foll-2', req)

      expect(response.success).toBe(true)
      expect(response.term).toBe(2)

      // Verify data integrity
      expect(storedSnapshot).toBeTruthy()
      expect(storedSnapshot!.length).toBe(1024)

      for (let i = 0; i < 1024; i++) {
        expect(storedSnapshot![i]).toBe((i * 7 + 31) % 256)
      }

      await followerConsensus.stop()
      await leaderTransport.stop()
      await followerTransport.stop()
      MockTransport.reset()
    })

    it('should allow follower to serve queries after InstallSnapshot', async () => {
      MockTransport.reset()

      const leaderTransport = new MockTransport('lead-q-1')
      const followerTransport = new MockTransport('foll-q-2')
      await leaderTransport.start()
      await followerTransport.start()

      const mockModule = createMockRaftModule()

      // Setup follower consensus with a stateful engine
      const storedNodes: Map<number, { typeId: number; name: string }> = new Map()
      let snapshotApplied = false

      const followerConfig: ConsensusConfig = {
        mode: 'raft-logic',
        nodeId: 'foll-q-2',
        peers: ['lead-q-1'],
      }
      const followerConsensus = new RaftLogicConsensus(followerConfig, mockModule)
      const followerEngine = {
        exportSnapshot: () => {
          const data = JSON.stringify({ nodes: Array.from(storedNodes.entries()) })
          return Buffer.from(data)
        },
        importSnapshot: (data: Buffer) => {
          const parsed = JSON.parse(data.toString())
          storedNodes.clear()
          for (const [id, info] of parsed.nodes) {
            storedNodes.set(id, info)
          }
          snapshotApplied = true
        },
      }
      ;(followerConsensus as any)._engine = followerEngine
      await followerConsensus.start()

      // Register message handlers
      followerTransport.onMessage((from: string, msg: any) => {
        if (msg.type === 'InstallSnapshot') {
          const req = msg.data as InstallSnapshotRequest
          followerConsensus.handleInstallSnapshot(req).then(resp => {
            MockTransport.sendResponse(from, 'foll-q-2', {
              type: 'InstallSnapshotResponse',
              term: resp.term,
              from: 'foll-q-2',
              to: from,
              data: resp,
            })
          })
        }
      })

      // Pre-populate follower with some data before snapshot (should be replaced)
      storedNodes.set(1, { typeId: 1, name: 'old-node' })

      // Create snapshot with different data
      const snapshotPayload = JSON.stringify({
        nodes: [
          [10, { typeId: 2, name: 'snapshot-node-1' }],
          [20, { typeId: 3, name: 'snapshot-node-2' }],
        ],
      })
      const snapshotData = Buffer.from(snapshotPayload)

      const req: InstallSnapshotRequest = {
        term: 3,
        leaderId: 'lead-q-1',
        lastIncludedIndex: 400,
        lastIncludedTerm: 3,
        data: snapshotData,
        done: true,
      }

      const response = await leaderTransport.installSnapshot('foll-q-2', req)
      expect(response.success).toBe(true)

      // Verify snapshot was applied
      expect(snapshotApplied).toBe(true)

      // Follower can accept queries after snapshot:
      // The mock engine should have replaced old-data with snapshot data
      expect(storedNodes.size).toBe(2)
      expect(storedNodes.get(10)).toBeDefined()
      expect(storedNodes.get(10)!.name).toBe('snapshot-node-1')
      expect(storedNodes.get(20)).toBeDefined()
      expect(storedNodes.get(20)!.name).toBe('snapshot-node-2')

      // Old data should be replaced, not merged
      expect(storedNodes.has(1)).toBe(false)

      await followerConsensus.stop()
      await leaderTransport.stop()
      await followerTransport.stop()
      MockTransport.reset()
    })
  })
})
