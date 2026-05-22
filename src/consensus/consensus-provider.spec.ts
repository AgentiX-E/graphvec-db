/**
 * ConsensusProvider spec
 *
 * ConsensusProvider is a TypeScript interface — runtime tests verify
 * that concrete implementations satisfy the contract:
 * - Default/initial state before start()
 * - Basic shape of ConsensusConfig
 */
import { ConsensusProvider, ConsensusRole, ConsensusConfig } from './consensus-provider'

class TestConsensusProvider implements ConsensusProvider {
  private _started = false

  constructor(private config: ConsensusConfig) {}

  async start(): Promise<void> {
    this._started = true
  }

  async stop(): Promise<void> {
    this._started = false
  }

  async propose(_data: Uint8Array, _timeoutMs?: number): Promise<{ ok: boolean }> {
    return { ok: this._started }
  }

  async readIndex(_timeoutMs?: number): Promise<void> {
    if (!this._started) throw new Error('not started')
  }

  getRole(): ConsensusRole {
    return this._started ? 'leader' : 'follower'
  }

  getLeaderId(): string | null {
    return this._started ? this.config.nodeId : null
  }

  getTerm(): number {
    return this._started ? 1 : 0
  }

  async waitForLeader(_timeoutMs?: number): Promise<void> {
    if (!this._started) throw new Error('not started')
  }
}

describe('ConsensusProvider (interface contract)', () => {
  const config: ConsensusConfig = {
    mode: 'standalone',
    nodeId: 'test-node',
    peers: [],
  }

  let provider: TestConsensusProvider

  beforeEach(() => {
    provider = new TestConsensusProvider(config)
  })

  test('should return follower role before start', () => {
    expect(provider.getRole()).toBe('follower')
  })

  test('should return null leader before start', () => {
    expect(provider.getLeaderId()).toBeNull()
  })

  test('should return term 0 before start', () => {
    expect(provider.getTerm()).toBe(0)
  })

  test('propose should fail before start', async () => {
    const result = await provider.propose(new Uint8Array([1, 2, 3]))
    expect(result.ok).toBe(false)
  })

  test('should start and return leader', async () => {
    await provider.start()
    expect(provider.getRole()).toBe('leader')
    expect(provider.getLeaderId()).toBe('test-node')
    expect(provider.getTerm()).toBe(1)
  })

  test('propose should succeed after start', async () => {
    await provider.start()
    const result = await provider.propose(new Uint8Array([1, 2, 3]))
    expect(result.ok).toBe(true)
  })

  test('should stop cleanly', async () => {
    await provider.start()
    await provider.stop()
    expect(provider.getRole()).toBe('follower')
  })

  test('readIndex should throw before start', async () => {
    await expect(provider.readIndex()).rejects.toThrow('not started')
  })

  test('waitForLeader should throw before start', async () => {
    await expect(provider.waitForLeader()).rejects.toThrow('not started')
  })
})

describe('ConsensusConfig shape', () => {
  test('should create standalone config', () => {
    const cfg: ConsensusConfig = {
      mode: 'standalone',
      nodeId: 'node-1',
      peers: [],
    }
    expect(cfg.mode).toBe('standalone')
    expect(cfg.nodeId).toBe('node-1')
    expect(cfg.peers).toEqual([])
  })

  test('should create simulated-raft config with optional fields', () => {
    const cfg: ConsensusConfig = {
      mode: 'simulated-raft',
      nodeId: 'node-2',
      peers: ['node-1', 'node-3'],
      electionTimeoutMs: 1000,
      heartbeatIntervalMs: 200,
    }
    expect(cfg.mode).toBe('simulated-raft')
    expect(cfg.electionTimeoutMs).toBe(1000)
    expect(cfg.heartbeatIntervalMs).toBe(200)
  })

  test('should create raft-logic config', () => {
    const cfg: ConsensusConfig = {
      mode: 'raft-logic',
      nodeId: 'node-1',
      peers: ['node-2', 'node-3'],
    }
    expect(cfg.mode).toBe('raft-logic')
  })
})

// Static type-level validation (compile-time only — no runtime assertions needed)
type _Contract = ConsensusProvider extends {
  start: () => Promise<void>
  stop: () => Promise<void>
  propose: (data: Uint8Array, timeoutMs?: number) => Promise<{ ok: boolean }>
  readIndex: (timeoutMs?: number) => Promise<void>
  getRole: () => ConsensusRole
  getLeaderId: () => string | null
  getTerm: () => number
  waitForLeader: (timeoutMs?: number) => Promise<void>
}
  ? true
  : false

// Satisfy TypeScript that we're using the type alias
const _: _Contract = true
