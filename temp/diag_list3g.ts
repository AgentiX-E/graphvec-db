import { parseQuery } from '../src/query/query-parser'

const q = `WITH 0 AS start, [1, 2, 500, 1000, 1500] AS stopList, [-1000, -3, -2, -1, 1, 2, 3, 1000] AS stepList
UNWIND stopList AS stop
UNWIND stepList AS step
WITH start, stop, step, range(start, stop, step) AS list
WITH start, stop, step, list, sign(stop-start) <> sign(step) AS empty
RETURN ALL(ok IN collect((size(list) = 0) = empty) WHERE ok) AS okay`

async function main() {
  const plan = parseQuery(q) as any
  console.log('aggregate =', JSON.stringify(plan.aggregate))
  console.log('expressionColumns =', JSON.stringify(plan.expressionColumns))
  console.log('returnColumns =', JSON.stringify(plan.returnColumns))
  console.log('returnAliasMap =', JSON.stringify(plan.returnAliasMap))
}
main().catch(e => console.error('ERR', e))
