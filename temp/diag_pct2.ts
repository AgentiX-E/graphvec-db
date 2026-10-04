import { parseQuery } from '../src/query/query-parser'

async function main() {
  const q = `MATCH (n:S) WITH n, size([(n)-->() | 1]) AS deg WHERE deg > 2 WITH deg LIMIT 100 RETURN percentileDisc(0.90, deg), deg`
  const plan = parseQuery(q) as any
  console.log('returnColumns =', JSON.stringify(plan.returnColumns))
  console.log('aggregate =', JSON.stringify(plan.aggregate))
  console.log('with.aggregates =', JSON.stringify(plan.with?.aggregates))
  console.log('aggCols =', JSON.stringify(plan.aggCols))
  console.log('with =', JSON.stringify(plan.with))
}
main().catch(e => console.error('ERR', e))
