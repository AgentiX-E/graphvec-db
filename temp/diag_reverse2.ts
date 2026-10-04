import { parseQuery } from '../src/query/query-parser'

async function main() {
  const q = `MATCH (x:X), (y:Y) CREATE (x)<-[:R]-(y)`
  const plan = parseQuery(q) as any
  console.log('plan.type =', plan.type)
  console.log('plan.multiMatch =', JSON.stringify(plan.multiMatch))
  console.log('plan.steps =', JSON.stringify(plan.steps))
  console.log('plan.createEdges =', JSON.stringify(plan.createEdges))
  console.log('plan.matchVar =', plan.matchVar)
}
main().catch(e => console.error('ERR', e))
