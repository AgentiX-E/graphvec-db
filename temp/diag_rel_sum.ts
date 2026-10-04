import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  const q = `UNWIND [1, 2, 3, 4, 5] AS x CREATE ()-[r:R {num: x}]->() WITH sum(r.num) AS sum RETURN sum`
  const plan = parseQuery(q) as any
  console.log('plan.aggregate =', JSON.stringify(plan.aggregate))
  console.log('plan.with =', JSON.stringify(plan.with))
  console.log('plan.createEdges =', JSON.stringify(plan.createEdges))
  console.log('plan.createNodes =', JSON.stringify(plan.createNodes))
  const nodes: any[] = []
  const res: any = await _executeQuery(plan, nodes, q)
  console.log('result =', JSON.stringify(res))
  console.log('nodes.len =', nodes.length)
}
main().catch(e => console.error('ERR', e))
