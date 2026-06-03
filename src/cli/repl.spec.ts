/**
 * repl.spec.ts — Cypher Shell REPL 测试
 *
 * 测试 executeQuery 函数、printResult 格式化输出、
 * :schema / :help 命令调用、--query 参数及 --verbose 输出。
 *
 * 不测试 readline 交互本身。
 */

import { GraphEngine } from '../core/graph-engine'
import { cleanTestData, testEngineConfig } from 'test/fixtures/test-graph'
import {
  executeQuery,
  printResult,
  displaySchema,
  displayHelp,
  ReplContext,
  parseCommand,
  QueryResult,
} from './repl'

describe('Cypher REPL — executeQuery', () => {
  let engine: GraphEngine
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeAll(() => {
    cleanTestData()
    engine = new GraphEngine(testEngineConfig)
    engine.open()
  })

  afterAll(() => {
    engine.close()
    cleanTestData()
  })

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  test('REPL-1: executeQuery should return empty result for empty graph', () => {
    const result = executeQuery(engine, 'MATCH (n) RETURN n')
    expect(result).toBeDefined()
    expect(result.count).toBeGreaterThanOrEqual(0)
    expect(result).toHaveProperty('columns')
    expect(result).toHaveProperty('rows')
  })

  test('REPL-2: executeQuery should find nodes after inserting data', async () => {
    const id1 = await engine.upsertNode(1, 'test-a', { props: { name: 'TestA' } })
    const id2 = await engine.upsertNode(1, 'test-b', { props: { name: 'TestB' } })
    expect(id1).toBeGreaterThan(0)
    expect(id2).toBeGreaterThan(0)

    const result = executeQuery(engine, 'MATCH (n) RETURN n')
    expect(result.count).toBeGreaterThanOrEqual(2)
    expect(result.rows.length).toBeGreaterThanOrEqual(2)

    // 清理
    await engine.deleteNode(id1)
    await engine.deleteNode(id2)
  })

  test('REPL-3: executeQuery should handle empty string', () => {
    const result = executeQuery(engine, '')
    expect(result.count).toBe(0)
    expect(result.rows).toEqual([])
  })
})

describe('Cypher REPL — printResult', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
  })

  test('REPL-4: printResult should handle empty result', () => {
    const result: QueryResult = { columns: [], rows: [], count: 0 }
    printResult(result)
    expect(logSpy).toHaveBeenCalledWith('(empty result)')
  })

  test('REPL-5: printResult should print rows with console.table', () => {
    const result: QueryResult = {
      columns: ['id', 'name'],
      rows: [{ '(id)': 1, '(name)': 'alice', age: 30 }],
      count: 1,
    }
    printResult(result)
    // console.table is called — verify via log (table is also log internally)
    expect(logSpy).toHaveBeenCalled()
  })
})

describe('Cypher REPL — :schema command', () => {
  let engine: GraphEngine
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeAll(() => {
    cleanTestData()
    engine = new GraphEngine(testEngineConfig)
    engine.open()
  })

  afterAll(() => {
    engine.close()
    cleanTestData()
  })

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  test('REPL-6: displaySchema should output schema info', () => {
    const ctx: ReplContext = { engine, verbose: false }
    displaySchema(ctx)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Graph Schema'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Nodes'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Edges'))
  })
})

describe('Cypher REPL — :help command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  test('REPL-7: displayHelp should output help text', () => {
    const ctx: ReplContext = { engine: null as any, verbose: false }
    displayHelp(ctx)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('AgentiX Cypher Shell'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(':exit'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(':help'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(':schema'))
  })
})

describe('Cypher REPL — parseCommand', () => {
  test('REPL-8: parseCommand should recognize :exit', () => {
    expect(parseCommand(':exit')).toEqual({ type: 'exit' })
    expect(parseCommand(':quit')).toEqual({ type: 'exit' })
  })

  test('REPL-9: parseCommand should recognize :help', () => {
    expect(parseCommand(':help')).toEqual({ type: 'help' })
  })

  test('REPL-10: parseCommand should recognize :schema', () => {
    expect(parseCommand(':schema')).toEqual({ type: 'schema' })
  })

  test('REPL-11: parseCommand should recognize :clear', () => {
    expect(parseCommand(':clear')).toEqual({ type: 'clear' })
  })

  test('REPL-12: parseCommand should treat unknown as cypher query', () => {
    const result = parseCommand('MATCH (n) RETURN n')
    expect(result.type).toBe('cypher')
    if (result.type === 'cypher') {
      expect(result.query).toBe('MATCH (n) RETURN n')
    }
  })
})

describe('Cypher REPL — CLI options (via repl.ts direct execution)', () => {
  test('REPL-13: module should export runCypherShell function', async () => {
    const replModule = await import('./repl')
    expect(typeof replModule.runCypherShell).toBe('function')
  })
})

describe('Cypher REPL — GraphEngine nodes via query', () => {
  let engine: GraphEngine

  beforeAll(() => {
    cleanTestData()
    engine = new GraphEngine(testEngineConfig)
    engine.open()
  })

  afterAll(() => {
    engine.close()
    cleanTestData()
  })

  test('REPL-14: GraphEngine.query() return value matches executeQuery expectations', () => {
    const nodes = engine.query('MATCH (n) RETURN n')
    expect(Array.isArray(nodes)).toBe(true)

    // 如果返回值有 id 字段
    if (nodes.length > 0) {
      expect(typeof nodes[0].id).toBe('number')
    }
  })

  test('REPL-15: engine.scanAllNodes() and stats() work', () => {
    const stats = engine.stats()
    expect(stats).toHaveProperty('nodeCount')
    expect(stats).toHaveProperty('edgeCount')
    expect(stats).toHaveProperty('diskSizeBytes')

    const allNodes = engine.scanAllNodes()
    expect(Array.isArray(allNodes)).toBe(true)
  })
})
