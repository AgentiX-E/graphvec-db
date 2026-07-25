// Direct MW2[1] TCK test
import { _executeQuery as executeQuery } from '../src/query/query-engine'
import { parseCypherToPlan } from '../src/query/ast-to-plan-v2'
import { registerIndex } from '../src/query/query-engine'

const nodes = [
  { _label: 'A', id: 0, name: 'a', __edges: [{srcIdx:0,dstIdx:1,label:''},{srcIdx:0,dstIdx:2,label:''},{srcIdx:0,dstIdx:3,label:''}] },
  { _label: 'B', id: 1, name: 'b', __edges: [{srcIdx:1,dstIdx:2,label:''},{srcIdx:1,dstIdx:3,label:''}] },
  { _label: 'C', id: 2, name: 'c', __edges: [{srcIdx:2,dstIdx:3,label:''}] },
  { _label: 'D', id: 3, name: 'd', __edges: [] },
  { _label: 'A', id: 0, name: 'a2', __edges: [{srcIdx:0,dstIdx:1,label:''},{srcIdx:0,dstIdx:2,label:''},{srcIdx:0,dstIdx:3,label:''}] },
  { _label: 'B', id: 1, name: 'b2', __edges: [{srcIdx:1,dstIdx:2,label:''},{srcIdx:1,dstIdx:3,label:''}] },
  { _label: 'C', id: 2, name: 'c2', __edges: [{srcIdx:2,dstIdx:3,label:''}] },
  { _label: 'D', id: 3, name: 'd2', __edges: [] },
] as any[]

async function main() {
  const q = 'MATCH (a)--(b)--(c)--(d)--(a), (b)--(d) WHERE a.id = 1 AND c.id = 2 RETURN d'
  const plan = parseCypherToPlan(q)
  const result = await executeQuery(plan as any, nodes)
  console.log('Result rows:', result.length)
  for (const r of result) {
    console.log('  d:', JSON.stringify(r))
  }
}
main().catch(console.error)
