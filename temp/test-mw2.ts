/**
 * 单独测试 MW2[1] 查询
 * MATCH (a)--(b)--(c)--(d)--(a), (b)--(d)
 * WHERE a.id = 1 AND c.id = 2 RETURN d
 */
import { parseQuery, _executeQuery, _clearGeInstances } from '../src/query/query-engine'

// 创建 TCK MW2[1] 的 seed 数据
const nodes: any[] = []

// CREATE (a:A {id:1}), (b:B {id:1}), (c:C {id:2}), (d:D {id:3})
const A = { _label: 'A', id: 1, name: 'a', __edges: [] as any[] }
const B = { _label: 'B', id: 1, name: 'b', __edges: [] as any[] }
const C = { _label: 'C', id: 2, name: 'c', __edges: [] as any[] }
const D = { _label: 'D', id: 3, name: 'd', __edges: [] as any[] }
const A2 = { _label: 'A', id: 1, name: 'a2', __edges: [] as any[] }
const B2 = { _label: 'B', id: 1, name: 'b2', __edges: [] as any[] }
const C2 = { _label: 'C', id: 2, name: 'c2', __edges: [] as any[] }
const D2 = { _label: 'D', id: 3, name: 'd2', __edges: [] as any[] }
const X = { _label: 'X', id: 4, name: 'x', __edges: [] as any[] }
const Y = { _label: 'Y', id: 5, name: 'y', __edges: [] as any[] }
const Z = { _label: 'Z', id: 6, name: 'z', __edges: [] as any[] }
const W = { _label: 'W', id: 7, name: 'w', __edges: [] as any[] }

nodes.push(A, B, C, D, A2, B2, C2, D2, X, Y, Z, W)

// CREATE (a)-[:T]->(b), (b)-[:T]->(c), (c)-[:T]->(d), (d)-[:T]->(a)
A.__edges.push({ srcIdx: 0, dstIdx: 1, label: 'T' })
B.__edges.push({ srcIdx: 1, dstIdx: 2, label: 'T' })
C.__edges.push({ srcIdx: 2, dstIdx: 3, label: 'T' })
D.__edges.push({ srcIdx: 3, dstIdx: 0, label: 'T' })

// 第二条链：A2-B2-C2-D2-A2
A2.__edges.push({ srcIdx: 4, dstIdx: 5, label: 'T' })
B2.__edges.push({ srcIdx: 5, dstIdx: 6, label: 'T' })
C2.__edges.push({ srcIdx: 6, dstIdx: 7, label: 'T' })
D2.__edges.push({ srcIdx: 7, dstIdx: 4, label: 'T' })

// 额外边：(b)--(d)，即 B-D 和 B2-D2
B.__edges.push({ srcIdx: 1, dstIdx: 3, label: 'T' })
B2.__edges.push({ srcIdx: 5, dstIdx: 7, label: 'T' })

// 其他节点间的随机边
X.__edges.push({ srcIdx: 8, dstIdx: 9, label: 'T' })
Y.__edges.push({ srcIdx: 9, dstIdx: 10, label: 'T' })
Z.__edges.push({ srcIdx: 10, dstIdx: 11, label: 'T' })
W.__edges.push({ srcIdx: 11, dstIdx: 8, label: 'T' })

async function main() {
  _clearGeInstances()
  const plan = parseQuery(
    'MATCH (a)--(b)--(c)--(d)--(a), (b)--(d) WHERE a.id = 1 AND c.id = 2 RETURN d'
  )
  console.log('=== PLAN ===')
  console.log('type:', plan.type)
  console.log('scanLabel:', plan.scanLabel)
  console.log('returnColumns:', plan.returnColumns)
  console.log('expressionColumns:', plan.expressionColumns)
  console.log('steps:', JSON.stringify(plan.steps.map((s: any) => ({
    source: s.source, targetAlias: s.targetAlias,
    direction: s.direction, edgeLabel: s.edgeLabel
  })), null, 2))
  console.log('filters:', JSON.stringify(plan.filters))
  console.log('labelFilterItems:', JSON.stringify(plan.labelFilterItems))
  console.log('')
  
  const result: any = await _executeQuery(plan, nodes)
  console.log('=== RESULT ===')
  console.log('type:', typeof result, 'isArr:', Array.isArray(result))
  console.log('raw:', JSON.stringify(result))
}

main().catch(e => console.error(e))
