import { describe, it, expect } from 'vitest'

describe('index (package entry)', () => {
  // Core
  it('exports GraphEngine', async () => {
    const mod = await import('./index')
    expect(mod.GraphEngine).toBeDefined()
  })

  it('exports GraphConfig', async () => {
    const mod = await import('./index')
    expect(mod.GraphConfig).toBeDefined()
  })

  // Consensus
  it('exports RaftNode (RangeInstance alias)', async () => {
    const mod = await import('./index')
    expect(mod.RaftNode).toBeDefined()
  })

  it('exports StandaloneConsensus', async () => {
    const mod = await import('./index')
    expect(mod.StandaloneConsensus).toBeDefined()
  })

  it('exports RaftLogicConsensus', async () => {
    const mod = await import('./index')
    expect(mod.RaftLogicConsensus).toBeDefined()
  })

  it('exports MockTransport', async () => {
    const mod = await import('./index')
    expect(mod.MockTransport).toBeDefined()
  })

  it('exports createConsensus', async () => {
    const mod = await import('./index')
    expect(mod.createConsensus).toBeDefined()
  })

  // Shard
  it('exports RangeInstance', async () => {
    const mod = await import('./index')
    expect(mod.RangeInstance).toBeDefined()
  })

  it('exports ShardRouter', async () => {
    const mod = await import('./index')
    expect(mod.ShardRouter).toBeDefined()
  })

  it('exports ShardManager', async () => {
    const mod = await import('./index')
    expect(mod.ShardManager).toBeDefined()
  })

  // Replication
  it('exports HlcClock', async () => {
    const mod = await import('./index')
    expect(mod.HlcClock).toBeDefined()
  })

  it('exports DeltaSync', async () => {
    const mod = await import('./index')
    expect(mod.DeltaSync).toBeDefined()
  })

  // Security
  it('exports Authenticator', async () => {
    const mod = await import('./index')
    expect(mod.Authenticator).toBeDefined()
  })

  it('exports RBAC', async () => {
    const mod = await import('./index')
    expect(mod.RBAC).toBeDefined()
  })

  it('exports AuditLogger', async () => {
    const mod = await import('./index')
    expect(mod.AuditLogger).toBeDefined()
  })

  // Materialized View
  it('exports MaterializedView', async () => {
    const mod = await import('./index')
    expect(mod.MaterializedView).toBeDefined()
  })

  // Resharding
  it('exports ReshardPlan', async () => {
    const mod = await import('./index')
    expect(mod.ReshardPlan).toBeDefined()
  })

  it('exports ReshardWorker', async () => {
    const mod = await import('./index')
    expect(mod.ReshardWorker).toBeDefined()
  })

  it('exports ReshardManager', async () => {
    const mod = await import('./index')
    expect(mod.ReshardManager).toBeDefined()
  })

  // Ops
  it('exports Metrics', async () => {
    const mod = await import('./index')
    expect(mod.Metrics).toBeDefined()
  })

  it('exports Logger', async () => {
    const mod = await import('./index')
    expect(mod.Logger).toBeDefined()
  })

  it('exports Health', async () => {
    const mod = await import('./index')
    expect(mod.Health).toBeDefined()
  })

  // Types (re-export)
  it('exports types from types.ts', async () => {
    const mod = await import('./index')
    expect(mod.NodeType).toBeDefined()
    expect(mod.EdgeType).toBeDefined()
    // RaftRole is a type alias (no runtime value), skip
    // ErrorCode is from error-codes.ts, not re-exported via index.ts
  })

  // Utils
  it('exports IdEncoder', async () => {
    const mod = await import('./index')
    expect(mod.IdEncoder).toBeDefined()
  })

  it('exports retry', async () => {
    const mod = await import('./index')
    expect(mod.retry).toBeDefined()
  })

  it('exports promise utilities', async () => {
    const mod = await import('./index')
    expect(mod.parallelLimit).toBeDefined()
    expect(mod.withTimeout).toBeDefined()
    expect(mod.waitFor).toBeDefined()
  })

  // Version info
  it('exports VERSION constant', async () => {
    const mod = await import('./index')
    expect(mod.VERSION).toBe('0.1.0')
  })

  it('exports NAME constant', async () => {
    const mod = await import('./index')
    expect(mod.NAME).toBe('agentiX-graphvec')
  })
})
