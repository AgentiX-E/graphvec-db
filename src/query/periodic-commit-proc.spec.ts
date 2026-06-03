import { describe, test, expect } from 'vitest'
import { PeriodicCommitProcedure, registerPeriodicCommit } from './periodic-commit'
import type { GraphEngineLike } from './periodic-commit'
import { ProcedureRegistry } from './procedure-registry'

const TOTAL_ROWS = 50

function makeEngine(): GraphEngineLike {
  return {
    executeQuery: async (query: string, _params: Record<string, unknown>) => {
      const limitMatch = query.match(/LIMIT\s+(\d+)/i)
      const skipMatch = query.match(/SKIP\s+(\d+)/i)
      const limit = limitMatch ? parseInt(limitMatch[1], 10) : 50
      const skip = skipMatch ? parseInt(skipMatch[1], 10) : 0
      const remaining = Math.max(0, TOTAL_ROWS - skip)
      const n = Math.min(limit, remaining)
      return { rows: Array(n).fill({}) }
    },
  }
}

describe('PeriodicCommitProcedure', () => {
  test('executes with default config', async () => {
    const proc = new PeriodicCommitProcedure(makeEngine() as any)
    const result = await proc.execute('MATCH (n:Person) SET n.flag = true')
    expect(result.batches).toBeGreaterThan(0)
    expect(result.totalRows).toBe(50)
    expect(result.failures).toBe(0)
    expect(result.failedBatches).toHaveLength(0)
    expect(result.timeMs).toBeGreaterThanOrEqual(0)
  })

  test('respects custom batch size', async () => {
    const proc = new PeriodicCommitProcedure(makeEngine() as any)
    const result = await proc.execute('MATCH (n) SET n.x = 1', { batchSize: 5 })
    expect(result.batches).toBe(10)
    expect(result.totalRows).toBe(50)
  })

  test('limits batches with maxBatches', async () => {
    const proc = new PeriodicCommitProcedure(makeEngine() as any)
    const result = await proc.execute('MATCH (n) SET n.x = 1', { batchSize: 5, maxBatches: 2 })
    expect(result.batches).toBe(2)
    expect(result.totalRows).toBe(10)
  })

  test('reports progress via callback', async () => {
    const proc = new PeriodicCommitProcedure(makeEngine() as any)
    const reports: any[] = []
    proc.setOnProgress((p) => { reports.push({ ...p }) })
    await proc.execute('MATCH (n) SET n.x = 1', { batchSize: 5, maxBatches: 2 })
    expect(reports.length).toBe(2)
  })

  test('fails on error when failOnError=true', async () => {
    const badEngine = { executeQuery: async () => { throw new Error('fail') } }
    const proc = new PeriodicCommitProcedure(badEngine as any)
    await expect(proc.execute('MATCH (n) DELETE n', { failOnError: true })).rejects.toThrow('Periodic commit failed')
  })

  test('skips failed batches when failOnError=false', async () => {
    const badEngine = {
      executeQuery: async (query: string) => {
        const limit = query.match(/LIMIT\s+(\d+)/i)
        const skip = query.match(/SKIP\s+(\d+)/i)
        if (skip && query.includes('SKIP 0')) throw new Error('skip0 fail')
        const remaining = Math.max(0, 50 - (skip ? parseInt(skip[1], 10) : 0))
        return { rows: Array(Math.min(limit ? parseInt(limit[1], 10) : 1, remaining)).fill({}) }
      },
    }
    const proc = new PeriodicCommitProcedure(badEngine as any)
    const result = await proc.execute('MATCH (n) DELETE n', { batchSize: 5 })
    expect(result.failures).toBeGreaterThanOrEqual(1)
  })

  test('normalizes query by removing SKIP/LIMIT', async () => {
    const proc = new PeriodicCommitProcedure(makeEngine() as any)
    const f = (proc as any)._normalizeQuery as (q: string) => string
    expect(f('SET n.x LIMIT 100')).toBe('SET n.x')
    expect(f('SET n.x SKIP 50')).toBe('SET n.x')
    expect(f('SET n.x SKIP 50 LIMIT 25;')).toBe('SET n.x')
  })

  test('returns correct result structure', async () => {
    const proc = new PeriodicCommitProcedure(makeEngine() as any)
    const result = await proc.execute('MATCH (n) SET n.x = 1', { batchSize: 10, maxBatches: 1 })
    expect(result).toHaveProperty('batches')
    expect(result).toHaveProperty('totalRows')
    expect(result).toHaveProperty('failures')
    expect(result).toHaveProperty('failedBatches')
    expect(result).toHaveProperty('timeMs')
    expect(Array.isArray(result.failedBatches)).toBe(true)
  })
})

describe('registerPeriodicCommit', () => {
  test('registers periodic.commit in registry', () => {
    const registry = new ProcedureRegistry()
    registerPeriodicCommit(registry, makeEngine() as any)
    expect(registry.hasProcedure('periodic.commit')).toBe(true)
  })

  test('lists periodic.commit in procedure list', () => {
    const registry = new ProcedureRegistry()
    registerPeriodicCommit(registry, makeEngine() as any)
    const list = registry.listProcedures()
    expect(list.find(p => p.name === 'periodic.commit')).toBeDefined()
  })

  test('calls periodic.commit via registry', async () => {
    const registry = new ProcedureRegistry()
    registerPeriodicCommit(registry, makeEngine() as any)
    const result = await registry.callProcedure(
      'periodic.commit',
      ['MATCH (n) SET n.x = 1', { batchSize: 50 }],
      { graph: makeEngine() as any },
    )
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(1)
    expect(result[0]).toHaveProperty('batches')
    expect(result[0]).toHaveProperty('totalRows')
  })

  test('throws when no query argument', async () => {
    const registry = new ProcedureRegistry()
    registerPeriodicCommit(registry, makeEngine() as any)
    await expect(
      registry.callProcedure('periodic.commit', [], { graph: makeEngine() as any }),
    ).rejects.toThrow('periodic.commit requires at least a query string')
  })
})
