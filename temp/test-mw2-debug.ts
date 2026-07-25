/**
 * 单独测试 MW2[1] 查询 — 带详细 debug
 */
import { _walkMultiSteps, _pathEndIndices } from '../src/query/query-parser'
import { parseQuery } from '../src/query/query-engine'

// 创建 TCK MW2[1] 的 seed 数据
const nodes: any[] = []

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

// 边（单向）
A.__edges.push({ srcIdx: 0, dstIdx: 1, label: 'T' })  // A→B
B.__edges.push({ srcIdx: 1, dstIdx: 2, label: 'T' })  // B→C
B.__edges.push({ srcIdx: 1, dstIdx: 3, label: 'T' })  // B→D
C.__edges.push({ srcIdx: 2, dstIdx: 3, label: 'T' })  // C→D
D.__edges.push({ srcIdx: 3, dstIdx: 0, label: 'T' })  // D→A

// 第二条链
A2.__edges.push({ srcIdx: 4, dstIdx: 5, label: 'T' })
B2.__edges.push({ srcIdx: 5, dstIdx: 6, label: 'T' })
B2.__edges.push({ srcIdx: 5, dstIdx: 7, label: 'T' })
C2.__edges.push({ srcIdx: 6, dstIdx: 7, label: 'T' })
D2.__edges.push({ srcIdx: 7, dstIdx: 4, label: 'T' })

// 噪音
X.__edges.push({ srcIdx: 8, dstIdx: 9, label: 'T' })
Y.__edges.push({ srcIdx: 9, dstIdx: 10, label: 'T' })
Z.__edges.push({ srcIdx: 10, dstIdx: 11, label: 'T' })
W.__edges.push({ srcIdx: 11, dstIdx: 8, label: 'T' })

const plan = parseQuery(
  'MATCH (a)--(b)--(c)--(d)--(a), (b)--(d) WHERE a.id = 1 AND c.id = 2 RETURN d'
)

const steps = plan.steps as any[]
console.log('Steps:', steps.length)

// 从节点 B (index 1, id=1) 开始 — 因为 WHERE a.id=1 且 B 是 a 的邻居
// 步0: source='a', stepSourceFilters 包含 a.id=1
// 所以从满足 a.id=1 的节点开始...但 a 是变量

// 实际上 _walkMultiSteps 中的 stepSourceFilters 对步0 source 做 pre-filter
// 让我们直接测试 _walkMultiSteps

// 测试从每个节点出发
for (let i = 0; i < nodes.length; i++) {
  const startLabel = nodes[i]._label
  const startId = nodes[i].id
  
  // 如果 stepSourceFilters = [{source:'a', property:'id', value:1}]
  // 起始节点 w.r.t source='a' 应该在 step 1+ 时检查
  // 但 pre-filter 会跳过 stepSourceFilters 不匹配的节点
  
  // 跳过 pre-filter，从 B (id=1) 开始测试
  if (startLabel !== 'B' || startId !== 1) continue
  
  console.log(`\n=== Start from node ${i} (${startLabel}, id=${startId}) ===`)
  
  // stepSourceFilters: [{source:'a', property:'id', op:'EQ', value:1}]
  const stepSourceFilters = [{source:'a', property:'id', value:1, operator:'EQ'}]
  
  const paths = _walkMultiSteps(i, steps, nodes, new Set(), plan.filters, stepSourceFilters)
  console.log(`Path count: ${paths.length}`)
  
  if (paths.length > 0) {
    const ends = _pathEndIndices(paths)
    console.log(`End indices: ${[...ends].join(', ')}`)
    for (const idx of ends) {
      console.log(`  End node: ${nodes[idx]._label}(${nodes[idx].id}) name=${nodes[idx].name}`)
    }
  }
  
  // Show the first few paths
  for (let pi = 0; pi < Math.min(3, paths.length); pi++) {
    const p = paths[pi]
    console.log(`  Path ${pi}: [${p.join('→')}] labels=[${p.map(j=>nodes[j]._label).join('→')}]`)
  }
}
