/**
 * 性能基准测试（vitest）
 * 运行: npx vitest run src/core/graph-engine.bench.ts --no-coverage
 * 或:    npx vitest run src/core/graph-engine.bench.ts --no-coverage --reporter=verbose
 */

import { describe, it, expect } from 'vitest'
import { GraphEngine } from './graph-engine'
import { _executeQuery, parseQuery, _registerIndex, _clearIndexes } from '../query/query-engine'

describe('GraphEngine Benchmark [100K nodes]', () => {
  it('BFS 1 步遍历（chain 50 nodes）', () => {
    const g = new GraphEngine({ path: '/tmp/bench-ge-bfs-' + Date.now(), denseVector: { dimension: 384 } })
    g.open()
    // 创建一条 50 个节点的链
    for (let i = 0; i < 50; i++) {
      g.upsertNode(1, 'n' + i, { props: { _label: 'Node', name: 'node-' + i } })
    }
    for (let i = 0; i < 49; i++) {
      g.upsertEdge(i + 1, { _type: 'NEXT' }, i + 2)
    }
    // BFS 从 node 1 遍历深度 1
    const n1 = g.neighbors(1, { maxDepth: 1 })
    expect(n1.nodes.length).toBeGreaterThanOrEqual(1)
    // BFS 完整遍历到链末端
    const nAll = g.neighbors(1, { maxDepth: 49 })
    expect(nAll.nodes.length).toBeGreaterThanOrEqual(49)
    g.close()
  })

  it('100K 节点扫描吞吐', () => {
    const g = new GraphEngine({ path: '/tmp/bench-ge-scan-' + Date.now(), denseVector: { dimension: 384 } })
    g.open()
    const N = 100000
    for (let i = 0; i < N; i++) {
      g.upsertNode(1, 'n' + i, { props: {
        _label: 'Person',
        name: 'node-' + i,
        age: Math.floor(Math.random() * 100),
      }})
    }
    const start = Date.now()
    let count = 0
    for (let i = 0; i < N; i++) {
      if (g.getNode(i + 1)) count++
    }
    const dur = Date.now() - start
    const ops = Math.round(N / dur * 1000)
    console.log(`\n  📊 100K getNode: ${dur}ms → ${ops.toLocaleString()} ops/s (count=${count})`)
    expect(count).toBe(N)
    g.close()
  })

  it('query-engine 500 queries (with index): MATCH+WHERE+RETURN on 100K nodes', async () => {
    _clearIndexes()
    const N = 100_000
    const nodes = Array.from({ length: N }, (_, i) => ({
      _label: 'Person',
      name: `person-${i}`,
      age: Math.floor(Math.random() * 100),
    }))
    // Register index on Person.name for EQ filter acceleration
    _registerIndex('Person', 'name')

    const plan = parseQuery("MATCH (n:Person) WHERE n.name = 'person-12345' RETURN n.name")
    const Q = 500
    const start = Date.now()
    for (let i = 0; i < Q; i++) {
      await _executeQuery(plan, nodes)
    }
    const dur = Date.now() - start
    const qps = Math.round(Q / dur * 1000)
    console.log(`  📊 ${Q} queries (with index): ${dur}ms → ${qps.toLocaleString()} qps (100K nodes)`)
    _clearIndexes()
  })
})

function qpsBench(): void {} // placeholder for benchmark runner
