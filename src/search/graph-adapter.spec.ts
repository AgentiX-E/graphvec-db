/**
 * GraphAdapter Tests
 *
 * Tests cover:
 * a. Normal path — toGraphologyGraph returns graphology Graph with correct order/size
 * b. Directed vs undirected graph creation
 * c. Empty GraphEngine (no nodes)
 * d. nodeLimit parameter
 * e. includeNodeProps / includeEdgeProps options
 * f. compareGraphs — identical engines
 * g. compareGraphs — different engines (missing/extra nodes)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GraphEngine } from '../core/graph-engine'
import { toGraphologyGraph, compareGraphs } from './graph-adapter'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'

function createEngine(path: string): GraphEngine {
  const engine = new GraphEngine({
    path,
    cacheSize: 100,
  })
  engine.open()
  return engine
}

async function seedGraph(engine: GraphEngine): Promise<void> {
  for (let i = 1; i <= 5; i++) {
    await engine.upsertNode(1, `node${i}`, {
      props: { label: `n${i}`, weight: i * 10 },
    })
  }
  // Chain: 1→2→3→4→5
  await engine.upsertEdge(1, 2, 10, { props: { rel: 'next' } })
  await engine.upsertEdge(2, 3, 10, { props: { rel: 'next' } })
  await engine.upsertEdge(3, 4, 10, { props: { rel: 'next' } })
  await engine.upsertEdge(4, 5, 10, { props: { rel: 'next' } })
}

async function seedLargeGraph(engine: GraphEngine): Promise<void> {
  for (let i = 1; i <= 10; i++) {
    await engine.upsertNode(1, `node${i}`)
  }
  for (let i = 1; i < 10; i++) {
    await engine.upsertEdge(i, i + 1, 10)
  }
}

describe('GraphAdapter — toGraphologyGraph', () => {
  let engine: GraphEngine
  let baseDir: string

  beforeAll(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'graph-adapter-test-'))
  })

  afterAll(() => {
    engine?.close()
    try { rmSync(baseDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  async function setupEngine(testName: string, seedFn?: (e: GraphEngine) => Promise<void>): Promise<GraphEngine> {
    const dir = join(baseDir, testName.replace(/[^a-zA-Z0-9]/g, '_'))
    const eng = createEngine(dir)
    if (seedFn) {
      await seedFn(eng)
    }
    return eng
  }

  it('a. Normal path — returns graphology Graph with correct order and size', async () => {
    engine = await setupEngine('normal_path', seedGraph)
    const result = await toGraphologyGraph(engine)

    expect(result.graph).toBeDefined()
    expect(result.nodeCount).toBe(5)
    expect(result.edgeCount).toBe(4)
    expect(result.graph.order).toBe(5)
    expect(result.graph.size).toBe(4)
  })

  it('b. Default options create a directed graph', async () => {
    engine = await setupEngine('directed_default', seedGraph)
    const result = await toGraphologyGraph(engine)

    expect(result.graph.type).toBe('directed')
  })

  it('c. directed: false creates an undirected graph', async () => {
    engine = await setupEngine('undirected', seedGraph)
    const result = await toGraphologyGraph(engine, { directed: false })

    expect(result.graph.type).toBe('undirected')
  })

  it('d. Empty GraphEngine returns graph with 0 nodes and 0 edges', async () => {
    engine = await setupEngine('empty')
    const result = await toGraphologyGraph(engine)

    expect(result.nodeCount).toBe(0)
    expect(result.edgeCount).toBe(0)
    expect(result.graph.order).toBe(0)
    expect(result.graph.size).toBe(0)
  })

  it('e. nodeLimit parameter limits the number of nodes', async () => {
    engine = await setupEngine('node_limit', seedLargeGraph)
    const result = await toGraphologyGraph(engine, { nodeLimit: 3 })

    expect(result.nodeCount).toBe(3)
    expect(result.graph.order).toBe(3)
  })

  it('f. includeNodeProps loads node properties', async () => {
    engine = await setupEngine('include_node_props', seedGraph)
    const result = await toGraphologyGraph(engine, { includeNodeProps: true })

    // Node 1 should have label and weight props
    const node1Attrs = result.graph.getNodeAttributes('1')
    expect(node1Attrs.label).toBe('n1')
    expect(node1Attrs.weight).toBe(10)
  })

  it('g. includeEdgeProps loads edge properties', async () => {
    engine = await setupEngine('include_edge_props', seedGraph)
    const result = await toGraphologyGraph(engine, { includeEdgeProps: true })

    // Edges should have type attribute
    const edges = result.graph.edges()
    expect(edges.length).toBeGreaterThan(0)
    const firstEdge = edges[0]
    const edgeAttrs = result.graph.getEdgeAttributes(firstEdge)
    expect(edgeAttrs.type).toBe('10')
  })

  it('h. Without includeNodeProps, node properties are not loaded', async () => {
    engine = await setupEngine('exclude_node_props', seedGraph)
    const result = await toGraphologyGraph(engine, { includeNodeProps: false })

    const node1Attrs = result.graph.getNodeAttributes('1')
    // label is always set (from node.name)
    expect(node1Attrs.name).toBe('node1')
    // props should not be present
    expect(node1Attrs.label).toBeUndefined()
    expect(node1Attrs.weight).toBeUndefined()
  })
})

describe('GraphAdapter — compareGraphs', () => {
  let engineA: GraphEngine
  let engineB: GraphEngine
  let engineC: GraphEngine
  let baseDir: string

  beforeAll(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'graph-adapter-compare-'))
  })

  afterAll(() => {
    engineA?.close()
    engineB?.close()
    engineC?.close()
    try { rmSync(baseDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  async function setupEngine(name: string, seedFn: (e: GraphEngine) => Promise<void>): Promise<GraphEngine> {
    const dir = join(baseDir, name)
    const eng = createEngine(dir)
    await seedFn(eng)
    return eng
  }

  it('a. Two identical GraphEngines → matched: true', async () => {
    engineA = await setupEngine('identical_a', seedGraph)
    engineB = await setupEngine('identical_b', seedGraph)

    const result = await compareGraphs(engineA, engineB)
    expect(result.matched).toBe(true)
    expect(result.missingNodes).toEqual([])
    expect(result.extraNodes).toEqual([])
  })

  it('b. Source has extra nodes → matched: false with correct lists', async () => {
    engineA = await setupEngine('extra_source', async (e) => {
      await seedGraph(e)
      // Add extra node only in source
      await e.upsertNode(1, 'extraNode')
    })
    engineB = await setupEngine('normal_target', seedGraph)

    const result = await compareGraphs(engineA, engineB)
    expect(result.matched).toBe(false)
    // The extra node (id=6) should be in missingNodes
    expect(result.missingNodes).toContain('6')
    expect(result.extraNodes).toEqual([])
  })

  it('c. Target has extra nodes → matched: false with correct lists', async () => {
    engineA = await setupEngine('normal_source', seedGraph)
    engineB = await setupEngine('extra_target', async (e) => {
      await seedGraph(e)
      await e.upsertNode(1, 'extraNode')
    })

    const result = await compareGraphs(engineA, engineB)
    expect(result.matched).toBe(false)
    expect(result.missingNodes).toEqual([])
    expect(result.extraNodes).toContain('6')
  })
})
