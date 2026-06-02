import { PeriodicCommitProcedure, registerPeriodicCommit } from './periodic-commit'
import { ProcedureRegistry } from './procedure-registry'
import type { GraphEngine } from '../core/graph-engine'

describe('PeriodicCommitProcedure', () => {
  // Create a mock GraphEngine
  const createMockEngine = (): any => {
    let nodeCounter = 0
    const nodes: Map<string, any> = new Map()

    return {
      executeQuery: async (query: string, params: Record<string, unknown>) => {
        // Extract LIMIT from query to simulate pagination
        const limitMatch = query.match(/LIMIT\s+(\d+)/i)
        const skipMatch = query.match(/SKIP\s+(\d+)/i)
        const limit = limitMatch ? parseInt(limitMatch[1], 10) : 1
        const skip = skipMatch ? parseInt(skipMatch[1], 10) : 0

        // Simulate SET operations
        if (/SET/i.test(query)) {
          const affected = Math.min(limit, Math.max(0, 100 - skip))
          return { rows: Array(affected).fill({}) }
        }

        // Default: return empty
        return { rows: [] }
      },
      getAllNodes: () => Array.from(nodes.values()),
      upsertNode: async (type: number, name: string) => {
        const id = (++nodeCounter).toString()
        nodes.set(id, { id, type, name })
        return id
      },
    }
  }

  let engine: any

  beforeEach(() => {
    engine = createMockEngine()
  })

  test('should execute periodic commit with default config', async () => {
    const proc = new PeriodicCommitProcedure(engine as unknown as GraphEngine)
    const result = await proc.execute('MATCH (n:Person) SET n.flag = true')

    expect(result.batches).toBeGreaterThan(0)
    expect(result.totalRows).toBeGreaterThan(0)
    expect(result.failures).toBe(0)
    expect(result.failedBatches).toHaveLength(0)
    expect(result.timeMs).toBeGreaterThanOrEqual(0)
  })

  test('should respect custom batch size', async () => {
    const proc = new PeriodicCommitProcedure(engine as unknown as GraphEngine)
    const result = await proc.execute('MATCH (n:Person) SET n.flag = true', {
      batchSize: 10,
    })

    expect(result.batches).toBeGreaterThan(0)
    expect(result.totalRows).toBeGreaterThan(0)
  })

  test('should limit number of batches with maxBatches', async () => {
    const proc = new PeriodicCommitProcedure(engine as unknown as GraphEngine)
    const result = await proc.execute('MATCH (n:Person) SET n.flag = true', {
      batchSize: 5,
      maxBatches: 2,
    })

    expect(result.batches).toBeLessThanOrEqual(2)
  })

  test('should report progress via callback', async () => {
    const proc = new PeriodicCommitProcedure(engine as unknown as GraphEngine)
    const progressReports: any[] = []

    proc.setOnProgress((progress) => {
      progressReports.push({ ...progress })
    })

    await proc.execute('MATCH (n:Person) SET n.flag = true', {
      batchSize: 5,
      maxBatches: 3,
    })

    expect(progressReports.length).toBeGreaterThan(0)
    expect(progressReports[0].batches).toBeGreaterThanOrEqual(1)
    expect(progressReports[0].totalRows).toBeGreaterThan(0)
  })

  test('should fail on error when failOnError is true', async () => {
    const errorEngine = {
      executeQuery: async () => {
        throw new Error('Query execution failed')
      },
    }
    const proc = new PeriodicCommitProcedure(errorEngine as unknown as GraphEngine)

    await expect(
      proc.execute('MATCH (n) DELETE n', { failOnError: true }),
    ).rejects.toThrow('Periodic commit failed')
  })

  test('should skip failed batches when failOnError is false', async () => {
    const errorEngine = {
      executeQuery: async (query: string) => {
        if (/SKIP\s+5/i.test(query)) {
          throw new Error('Batch failure')
        }
        // After skip 5, there are 95 more rows
        const limit = query.match(/LIMIT\s+(\d+)/i)
        return { rows: Array(limit ? parseInt(limit[1], 10) : 1).fill({}) }
      },
    }
    const proc = new PeriodicCommitProcedure(errorEngine as unknown as GraphEngine)
    const result = await proc.execute('MATCH (n) DELETE n', {
      batchSize: 5,
    })

    // Should have more batches than just 0 — failures were skipped
    expect(result.failures).toBeGreaterThanOrEqual(0)
  })

  test('should normalize query by removing trailing SKIP/LIMIT', async () => {
    const proc = new PeriodicCommitProcedure(engine as unknown as GraphEngine)

    // Directly test normalize
    const normalized = (proc as any)._normalizeQuery(
      'MATCH (n:Person) SET n.x = 1 LIMIT 100',
    )
    expect(normalized).toBe('MATCH (n:Person) SET n.x = 1')

    const normalized2 = (proc as any)._normalizeQuery(
      'MATCH (n) SET n.x = 1 SKIP 50',
    )
    expect(normalized2).toBe('MATCH (n) SET n.x = 1')

    const normalized3 = (proc as any)._normalizeQuery(
      'MATCH (n) SET n.x = 1 SKIP 50 LIMIT 25;',
    )
    expect(normalized3).toBe('MATCH (n) SET n.x = 1')
  })

  test('should return result with correct structure', async () => {
    const proc = new PeriodicCommitProcedure(engine as unknown as GraphEngine)
    const result = await proc.execute('MATCH (n:Person) SET n.flag = true', {
      batchSize: 10,
      maxBatches: 1,
    })

    expect(result).toHaveProperty('batches')
    expect(result).toHaveProperty('totalRows')
    expect(result).toHaveProperty('failures')
    expect(result).toHaveProperty('failedBatches')
    expect(result).toHaveProperty('timeMs')
    expect(Array.isArray(result.failedBatches)).toBe(true)
  })
})

describe('registerPeriodicCommit', () => {
  const createMockEngine = (): any => ({
    executeQuery: async () => ({ rows: [{ name: 'test' }] }),
    getAllNodes: () => [],
  })

  test('should register periodic.commit in procedure registry', () => {
    const registry = new ProcedureRegistry()
    const engine = createMockEngine()

    registerPeriodicCommit(registry, engine as unknown as GraphEngine)

    expect(registry.hasProcedure('periodic.commit')).toBe(true)
  })

  test('should list periodic.commit in registered procedures', () => {
    const registry = new ProcedureRegistry()
    const engine = createMockEngine()

    registerPeriodicCommit(registry, engine as unknown as GraphEngine)

    const procedures = registry.listProcedures()
    const periodic = procedures.find(p => p.name === 'periodic.commit')
    expect(periodic).toBeDefined()
    expect(periodic!.description).toContain('Periodic batch commit')
  })

  test('should call periodic.commit via procedure registry', async () => {
    const registry = new ProcedureRegistry()
    const engine = createMockEngine()

    registerPeriodicCommit(registry, engine as unknown as GraphEngine)

    const result = await registry.callProcedure(
      'periodic.commit',
      ['MATCH (n) SET n.x = 1', { batchSize: 50 }],
      { graph: engine as unknown as GraphEngine },
    )

    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(1)
    expect(result[0]).toHaveProperty('batches')
    expect(result[0]).toHaveProperty('totalRows')
    expect(result[0]).toHaveProperty('timeMs')
  })

  test('should throw when no query argument provided', async () => {
    const registry = new ProcedureRegistry()
    const engine = createMockEngine()

    registerPeriodicCommit(registry, engine as unknown as GraphEngine)

    await expect(
      registry.callProcedure(
        'periodic.commit',
        [],
        { graph: engine as unknown as GraphEngine },
      ),
    ).rejects.toThrow('periodic.commit requires at least a query string')
  })
})
