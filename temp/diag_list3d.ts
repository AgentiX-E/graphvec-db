import { parseQuery } from '../src/query/query-parser'

async function main() {
  const q = `WITH [1,2,3] AS stopList UNWIND stopList AS stop RETURN collect(stop > 0) AS c`
  const plan = parseQuery(q) as any
  console.log('expressionColumns =', JSON.stringify(plan.expressionColumns))
  console.log('aggregate =', JSON.stringify(plan.aggregate))
  console.log('aggregates =', JSON.stringify(plan.aggregates))
  console.log('groupBy =', JSON.stringify(plan.groupBy))
  console.log('returnColumns =', JSON.stringify(plan.returnColumns))
  console.log('returnAliasMap =', JSON.stringify(plan.returnAliasMap))
}
main().catch(e => console.error('ERR', e))
