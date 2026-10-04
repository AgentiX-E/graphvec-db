import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  const q = `UNWIND [1, 2, 3, 4, 5] AS x CREATE (n:N {num: x}) WITH sum(n.num) AS sum RETURN sum`
  const plan = parseQuery(q) as any
  console.log('plan.aggregate =', JSON.stringify(plan.aggregate))
  console.log('plan.with =', JSON.stringify(plan.with))
  const nodes: any[] = []
  const res: any = await _executeQuery(plan, nodes, q)
  console.log('result =', JSON.stringify(res))
  console.log('nodes after =', JSON.stringify(nodes.map(n => ({label:n._label, num:n.num}))))
}
main().catch(e => console.error('ERR', e))
