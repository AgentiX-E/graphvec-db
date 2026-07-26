import { _executeViaGraphEngine } from './src/query/query-executor'
import { parseCypherToPlan } from './src/query/ast-to-plan-v2'

// Test data: advertiser(0)→p1(1), advertiser(0)→p2(2), thing(3)→red(4), p1(1)→red(4), p2(2)→red(4)
const nodes: any[] = [
  { _label: 'advertiser', id: 0, name: 'advertiser', __edges: [] as any[] },
  { _label: 'p', id: 1, name: 'product1', __edges: [] as any[] },
  { _label: 'p', id: 2, name: 'product4', __edges: [] as any[] },
  { _label: 'thing', id: 3, name: 'thing', __edges: [] as any[] },
  { _label: 'red', id: 4, name: 'red', __edges: [] as any[] },
]
nodes[0].__edges.push({srcIdx:0,dstIdx:1,label:'ADV_HAS_PRODUCT'},{srcIdx:0,dstIdx:2,label:'ADV_HAS_PRODUCT'})
nodes[1].__edges.push({srcIdx:1,dstIdx:4,label:'AP_HAS_VALUE'})
nodes[2].__edges.push({srcIdx:2,dstIdx:4,label:'AP_HAS_VALUE'})
nodes[3].__edges.push({srcIdx:3,dstIdx:4,label:'AA_HAS_VALUE'})
nodes[4].__edges.push({srcIdx:4,dstIdx:3,label:'AA_HAS_VALUE'}) // reverse for direction='in'

const q = `MATCH (advertiser)-[:ADV_HAS_PRODUCT]->(out)-[:AP_HAS_VALUE]->(red)<-[:AA_HAS_VALUE]-(a) WHERE advertiser.id = $1 AND a.id = $2 AND red.name = 'red' AND out.name = 'product1' RETURN out.name`
const plan = parseCypherToPlan(q)
console.log('steps:', JSON.stringify(plan.steps?.map(s => ({s:s.source,t:s.targetAlias,d:s.direction,e:s.edgeLabel}))))
console.log('retCols:', plan.returnColumns)
console.log('exprCols:', plan.expressionColumns?.length)
console.log('filters:', plan.filters?.length)

async function main() {
  // Set params
  const params = { '1': 0, '2': 3 }
  // param injection
  const injectedPlan = JSON.parse(JSON.stringify(plan, (k,v) => v))
  injectedPlan.filters = plan.filters?.map(f => ({
    ...f,
    value: typeof f.value === 'string' && f.value.startsWith('$') ? params[f.value.slice(1)] ?? f.value : f.value
  }))
  const result = await _executeViaGraphEngine(injectedPlan, nodes, q)
  console.log('rows:', result.length)
  for (const r of result) console.log('  ', JSON.stringify(r))
}
main()
