import { parseQuery } from '../src/query/query-parser'

async function main() {
  const q = `MATCH (n:S) WITH n, size([(n)-->() | 1]) AS deg WHERE deg > 2 WITH deg LIMIT 100 RETURN percentileDisc(0.90, deg), deg`
  const plan = parseQuery(q) as any
  console.log('with =', JSON.stringify(plan.with))
  console.log('withChain =', JSON.stringify(plan.withChain))
  console.log('aggregate =', JSON.stringify(plan.aggregate))
  console.log('steps =', JSON.stringify(plan.steps))
  console.log('groupBy =', JSON.stringify(plan.groupBy))
}
main().catch(e => console.error('ERR', e))
