/**
 * tck-run-engine.ts — 直接跑 TCK 在 GraphEngine 上
 *
 * 读取 openCypher-tck.spec.ts 中的 test cases
 * (query + data pairs)，注入 engine 并验证。
 *
 * 运行：TCK_ENGINE_PATH=/tmp/tck-engine npx tsx tck-run-engine.ts
 */

import { createTCKEngine, destroyTCKEngine, injectNodes, injectEdge, tckQuery } from './src/query/cypher-tck/tck-engine-adapter'

// TCK test cases extracted from openCypher-tck.spec.ts
// Group by section as in the spec file

type TCKCase = {
  name: string
  query: string
  data: Record<string, any>[]
  expect: (result: Record<string, any>[]) => boolean | string
  edges?: [number, number, string][]
}

function eq(result: Record<string, any>[], expectedLen: number): boolean | string {
  if (result.length !== expectedLen)
    return `expected ${expectedLen} rows, got ${result.length}`
  return true
}

// ── 1. MATCH 模式匹配 ──
const MATCH_TESTS: TCKCase[] = [
  {
    name: 'MATCH-01: Basic MATCH label',
    query: 'MATCH (n:Person) RETURN n',
    data: [{ _label: 'Person', name: 'Alice' }, { _label: 'Person', name: 'Bob' }, { _label: 'Company', name: 'Acme' }],
    expect: r => eq(r, 2),
  },
  {
    name: 'MATCH-02: MATCH all nodes',
    query: 'MATCH (n) RETURN n',
    data: [{ _label: 'Person', name: 'Alice' }, { _label: 'Company', name: 'Acme' }],
    expect: r => eq(r, 2),
  },
  {
    name: 'MATCH-03: MATCH with WHERE',
    query: "MATCH (n:Person) WHERE n.name = 'Alice' RETURN n",
    data: [{ _label: 'Person', name: 'Alice' }, { _label: 'Person', name: 'Bob' }],
    expect: r => eq(r, 1),
  },
  {
    name: 'MATCH-04: MATCH with numeric WHERE',
    query: 'MATCH (n:Person) WHERE n.age > 25 RETURN n',
    data: [{ _label: 'Person', name: 'Alice', age: 30 }, { _label: 'Person', name: 'Bob', age: 20 }],
    expect: r => eq(r, 1),
  },
  {
    name: 'MATCH-05: MATCH edge',
    query: 'MATCH (a)-[:KNOWS]->(b) RETURN a, b',
    data: [{ _label: 'Person', name: 'Alice' }, { _label: 'Person', name: 'Bob' }],
    expect: r => eq(r, 1),
    edges: [[0, 1, 'KNOWS']],
  },
  {
    name: 'MATCH-06: MATCH with ORDER BY',
    query: 'MATCH (n:Person) RETURN n ORDER BY n.age',
    data: [{ _label: 'Person', name: 'Bob', age: 20 }, { _label: 'Person', name: 'Alice', age: 30 }],
    expect: r => {
      if (r.length !== 2) return `expected 2, got ${r.length}`
      const ages = r.map(row => row.n.age)
      if (ages[0] > ages[1]) return `ORDER BY failed: ${JSON.stringify(ages)}`
      return true
    },
  },
  {
    name: 'MATCH-07: MATCH with LIMIT',
    query: 'MATCH (n:Person) RETURN n LIMIT 1',
    data: [{ _label: 'Person', name: 'Alice' }, { _label: 'Person', name: 'Bob' }],
    expect: r => eq(r, 1),
  },
  {
    name: 'MATCH-08: OPTIONAL MATCH (no match)',
    query: "MATCH (n:Person) OPTIONAL MATCH (n)-[:KNOWS]->(m) RETURN n, m",
    data: [{ _label: 'Person', name: 'Alice' }],
    expect: r => {
      if (r.length !== 1) return `expected 1, got ${r.length}`
      return true
    },
  },
  {
    name: 'MATCH-09: Multiple labels',
    query: 'MATCH (n:Person) RETURN n UNION MATCH (n:Company) RETURN n',
    data: [{ _label: 'Person', name: 'Alice' }, { _label: 'Company', name: 'Acme' }],
    expect: r => eq(r, 2),
  },
  {
    name: 'MATCH-10: WHERE with IN list',
    query: "MATCH (n:Person) WHERE n.name IN ['Alice', 'Carol'] RETURN n",
    data: [{ _label: 'Person', name: 'Alice' }, { _label: 'Person', name: 'Bob' }, { _label: 'Person', name: 'Carol' }],
    expect: r => eq(r, 2),
  },
]

// ── 2. RETURN 投影 ──
const RETURN_TESTS: TCKCase[] = [
  {
    name: 'RETURN-01: RETURN property',
    query: 'MATCH (n:Person) RETURN n.name',
    data: [{ _label: 'Person', name: 'Alice' }],
    expect: r => eq(r, 1),
  },
  {
    name: 'RETURN-02: RETURN multiple props',
    query: 'MATCH (n:Person) RETURN n.name, n.age',
    data: [{ _label: 'Person', name: 'Alice', age: 30 }],
    expect: r => eq(r, 1),
  },
  {
    name: 'RETURN-03: AS alias',
    query: 'MATCH (n:Person) RETURN n.name AS personName',
    data: [{ _label: 'Person', name: 'Alice' }],
    expect: r => eq(r, 1),
  },
  {
    name: 'RETURN-04: ORDER BY DESC',
    query: 'MATCH (n:Person) RETURN n.name ORDER BY n.name DESC',
    data: [{ _label: 'Person', name: 'Alice' }, { _label: 'Person', name: 'Bob' }],
    expect: r => eq(r, 2),
  },
  {
    name: 'RETURN-05: DISTINCT',
    query: 'MATCH (n:Person) RETURN DISTINCT n.age',
    data: [{ _label: 'Person', name: 'Alice', age: 30 }, { _label: 'Person', name: 'Bob', age: 30 }],
    expect: r => eq(r, 1),
  },
  {
    name: 'RETURN-06: SKIP',
    query: 'MATCH (n:Person) RETURN n.name ORDER BY n.name SKIP 1',
    data: [{ _label: 'Person', name: 'Alice' }, { _label: 'Person', name: 'Bob' }],
    expect: r => eq(r, 1),
  },
]

// ── Run ──
async function runTests() {
  const allTests = [...MATCH_TESTS, ...RETURN_TESTS]
  let pass = 0
  let fail = 0
  const failures: string[] = []

  for (const t of allTests) {
    const engine = createTCKEngine()
    try {
      const ids = await injectNodes(engine, t.data)
      if (t.edges) {
        for (const [src, dst, type] of t.edges) {
          await injectEdge(engine, ids[src], ids[dst], type)
        }
      }

      const result = tckQuery(engine, t.query)
      const check = t.expect(result)

      if (check === true) {
        pass++
      } else {
        fail++
        failures.push(`FAIL ${t.name}: ${check}`)
      }
    } catch (err: any) {
      fail++
      failures.push(`ERROR ${t.name}: ${err.message?.slice(0, 150)}`)
    }

    await destroyTCKEngine(engine)
  }

  console.log('\n=== TCK → GraphEngine Results ===')
  console.log(`Pass: ${pass}/${allTests.length}`)
  console.log(`Fail: ${fail}/${allTests.length}`)
  for (const f of failures) {
    console.log(`  ${f}`)
  }

  if (fail > 0) process.exit(1)
}

runTests().catch(err => { console.error(err); process.exit(1) })
