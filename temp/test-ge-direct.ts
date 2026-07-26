// Quick test: use the data format from test-mw2.ts in _executeViaGraphEngine
import { _executeViaGraphEngine } from '../src/query/query-executor'
import { parseCypherToPlan } from '../src/query/ast-to-plan-v2'

const A = { _label: 'A', id: 1, name: 'a', __edges: [] as any[] }
const B = { _label: 'B', id: 1, name: 'b', __edges: [] as any[] }
const C = { _label: 'C', id: 2, name: 'c', __edges: [] as any[] }
const D = { _label: 'D', id: 3, name: 'd', __edges: [] as any[] }
const A2 = { _label: 'A', id: 1, name: 'a2', __edges: [] as any[] }
const B2 = { _label: 'B', id: 1, name: 'b2', __edges: [] as any[] }
const C2 = { _label: 'C', id: 2, name: 'c2', __edges: [] as any[] }
const D2 = { _label: 'D', id: 3, name: 'd2', __edges: [] as any[] }

A.__edges.push({srcIdx:0,dstIdx:1,label:''},{srcIdx:0,dstIdx:2,label:''},{srcIdx:0,dstIdx:3,label:''})
B.__edges.push({srcIdx:1,dstIdx:2,label:''},{srcIdx:1,dstIdx:3,label:''})
C.__edges.push({srcIdx:2,dstIdx:3,label:''})
D.__edges.push({srcIdx:3,dstIdx:0,label:''},{srcIdx:3,dstIdx:1,label:''},{srcIdx:3,dstIdx:2,label:''})
A2.__edges.push({srcIdx:4,dstIdx:5,label:''},{srcIdx:4,dstIdx:6,label:''},{srcIdx:4,dstIdx:7,label:''})
B2.__edges.push({srcIdx:5,dstIdx:6,label:''},{srcIdx:5,dstIdx:7,label:''})
C2.__edges.push({srcIdx:6,dstIdx:7,label:''})
D2.__edges.push({srcIdx:7,dstIdx:4,label:''},{srcIdx:7,dstIdx:5,label:''},{srcIdx:7,dstIdx:6,label:''})

const nodes = [A,B,C,D,A2,B2,C2,D2]

async function main() {
  const q = 'MATCH (a)--(b)--(c)--(d)--(a), (b)--(d) WHERE a.id = 1 AND c.id = 2 RETURN d'
  const plan = parseCypherToPlan(q)
  const r = await _executeViaGraphEngine(plan as any, nodes, q)
  console.log('rows:', r.length)
  for (const row of r) console.log(' ', JSON.stringify(row))
}
main().catch(console.error)
