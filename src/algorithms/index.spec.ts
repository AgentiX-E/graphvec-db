import { describe, it, expect } from 'vitest'

describe('algorithms/index', () => {
  it('exports minimumSpanningTree', async () => {
    const mod = await import('./index')
    expect(mod.minimumSpanningTree).toBeDefined()
    expect(typeof mod.minimumSpanningTree).toBe('function')
  })

  it('exports maxFlow', async () => {
    const mod = await import('./index')
    expect(mod.maxFlow).toBeDefined()
    expect(typeof mod.maxFlow).toBe('function')
  })

  it('exports betweennessCentrality', async () => {
    const mod = await import('./index')
    expect(mod.betweennessCentrality).toBeDefined()
    expect(typeof mod.betweennessCentrality).toBe('function')
  })

  it('exports louvainCommunity', async () => {
    const mod = await import('./index')
    expect(mod.louvainCommunity).toBeDefined()
    expect(typeof mod.louvainCommunity).toBe('function')
  })

  it('exports bfs', async () => {
    const mod = await import('./index')
    expect(mod.bfs).toBeDefined()
    expect(typeof mod.bfs).toBe('function')
  })

  it('exports dfs', async () => {
    const mod = await import('./index')
    expect(mod.dfs).toBeDefined()
    expect(typeof mod.dfs).toBe('function')
  })

  it('exports pagerank', async () => {
    const mod = await import('./index')
    expect(mod.pagerank).toBeDefined()
    expect(typeof mod.pagerank).toBe('function')
  })

  it('exports dijkstra', async () => {
    const mod = await import('./index')
    expect(mod.dijkstra).toBeDefined()
    expect(typeof mod.dijkstra).toBe('function')
  })

  it('exports BatchProcessor', async () => {
    const mod = await import('./index')
    expect(mod.BatchProcessor).toBeDefined()
  })

  it('exports wcc', async () => {
    const mod = await import('./index')
    expect(mod.wcc).toBeDefined()
    expect(typeof mod.wcc).toBe('function')
  })

  it('exports scc', async () => {
    const mod = await import('./index')
    expect(mod.scc).toBeDefined()
    expect(typeof mod.scc).toBe('function')
  })

  it('exports triangleCount', async () => {
    const mod = await import('./index')
    expect(mod.triangleCount).toBeDefined()
    expect(typeof mod.triangleCount).toBe('function')
  })

  it('exports labelPropagation', async () => {
    const mod = await import('./index')
    expect(mod.labelPropagation).toBeDefined()
    expect(typeof mod.labelPropagation).toBe('function')
  })

  it('exports degreeCentrality', async () => {
    const mod = await import('./index')
    expect(mod.degreeCentrality).toBeDefined()
    expect(typeof mod.degreeCentrality).toBe('function')
  })

  it('exports GnnInferenceEngine', async () => {
    const mod = await import('./index')
    expect(mod.GnnInferenceEngine).toBeDefined()
  })

  it('exports LinkPredictor', async () => {
    const mod = await import('./index')
    expect(mod.LinkPredictor).toBeDefined()
  })

  it('exports empty re-export files (p1-6-edge-index-decision)', async () => {
    const mod = await import('./index')
    expect(mod).toBeDefined()
  })
})
