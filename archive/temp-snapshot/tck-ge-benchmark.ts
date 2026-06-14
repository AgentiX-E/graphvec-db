/**
 * temp/tck-ge-benchmark.ts — 直接跑全量 TCK 在 GraphEngine 上
 *
 * 不依赖 vi.mock。手动提取 TCK 文件中的 query+data pairs，
 * 注入 engine 后执行。
 *
 * 运行：npx tsx temp/tck-ge-benchmark.ts
 */

import { createTCKEngine, destroyTCKEngine, injectNodes, injectEdge, tckQuery } from '../src/query/cypher-tck/tck-engine-adapter'

// List of critical TCK queries to verify
// Extracted from openCypher-tck.spec.ts
const TCK_QUERIES = [
  // MATCH basic
  { q: 'MATCH (n:Person) RETURN n', data: [{ _label: 'Person', name: 'Alice' }], expectLen: 1 },
  { q: 'MATCH (n:Person) RETURN n', data: [{ _label: 'Person', name: 'Alice' }, { _label: 'Company', name: 'Acme' }], expectLen: 1 },
  { q: 'MATCH (n) RETURN n', data: [{ _label: 'Person', name: 'Alice' }, { _label: 'Company', name: 'Acme' }], expectLen: 2 },

  // WHERE
  { q: "MATCH (n:Person) WHERE n.name = 'Alice' RETURN n", data: [{ _label: 'Person', name: 'Alice', age: 30 }, { _label: 'Person', name: 'Bob', age: 25 }], expectLen: 1 },
  { q: 'MATCH (n:Person) WHERE n.age > 25 RETURN n', data: [{ _label: 'Person', name: 'Alice', age: 30 }, { _label: 'Person', name: 'Bob', age: 25 }], expectLen: 1 },
  { q: 'MATCH (n) WHERE n.age < 30 RETURN n', data: [{ _label: 'Person', name: 'Alice', age: 30 }, { _label: 'Person', name: 'Bob', age: 25 }], expectLen: 1 },

  // Edge
  { q: 'MATCH (a)-[:KNOWS]->(b) RETURN a, b', data: [{ _label: 'Person', name: 'Alice' }, { _label: 'Person', name: 'Bob' }], edge: true, expectLen: 1 },

  // ORDER BY
  { q: 'MATCH (n:Person) RETURN n ORDER BY n.age', data: [{ _label: 'Person', name: 'Alice', age: 30 }, { _label: 'Person', name: 'Bob', age: 25 }], expectLen: 2 },

  // LIMIT
  { q: 'MATCH (n:Person) RETURN n LIMIT 1', data: [{ _label: 'Person', name: 'Alice', age: 30 }, { _label: 'Person', name: 'Bob', age: 25 }], expectLen: 1 },

  // RETURN *
  { q: 'MATCH (n:Person) RETURN *', data: [{ _label: 'Person', name: 'Alice' }], expectLen: 1 },
]

async function main() {
  let pass = 0
  let fail = 0
  const failures: string[] = []

  for (const tck of TCK_QUERIES) {
    const engine = createTCKEngine()
    try {
      const ids = await injectNodes(engine, tck.data)
      if (tck.edge && ids.length >= 2) {
        await injectEdge(engine, ids[0], ids[1], 'KNOWS')
      }

      const result = tckQuery(engine, tck.q)
      const actualLen = result.length

      if (actualLen === tck.expectLen) {
        pass++
      } else {
        fail++
        failures.push(`FAIL ${tck.q}: expected ${tck.expectLen} rows, got ${actualLen}`)
      }
    } catch (err: any) {
      fail++
      failures.push(`ERROR ${tck.q}: ${err.message?.slice(0, 100)}`)
    }

    await destroyTCKEngine(engine)
  }

  console.log(`\n=== TCK-GE Benchmark Results ===`)
  console.log(`Pass: ${pass}/${TCK_QUERIES.length}`)
  console.log(`Fail: ${fail}/${TCK_QUERIES.length}`)
  for (const f of failures) {
    console.log(`  ${f}`)
  }
}

main().catch(console.error)
