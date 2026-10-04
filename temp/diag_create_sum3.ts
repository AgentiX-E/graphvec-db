import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  const q = `UNWIND [1, 2, 3, 4, 5] AS x CREATE (n:N {num: x}) RETURN sum(n.num) AS sum`
  const plan = parseQuery(q) as any
  console.log('returnColumns =', JSON.stringify(plan.returnColumns))
  console.log('expressionColumns =', JSON.stringify(plan.expressionColumns))
  console.log('returnAliasMap =', JSON.stringify(plan.returnAliasMap))
  console.log('aggregate.alias =', JSON.stringify(plan.aggregate?.alias))
  const res: any = await _executeQuery(plan, [], q)
  console.log('result =', JSON.stringify(res))
}
main().catch(e => console.error('ERR', e))
