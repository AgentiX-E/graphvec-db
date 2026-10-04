import { parseQuery } from '../src/query/query-parser'

const q = `MATCH (a:A), (b:B) WITH [p = (a)-[*]->(b) | p] AS paths, count(a) AS c RETURN paths, c`
async function main() {
  const plan = parseQuery(q) as any
  console.log('with.columns =', JSON.stringify(plan.with?.columns, null, 2))
  console.log('with.aggregate =', JSON.stringify(plan.with?.aggregate))
  console.log('aggregate =', JSON.stringify(plan.aggregate))
  console.log('expressionColumns =', JSON.stringify(plan.expressionColumns))
  console.log('hasMatch =', plan.hasMatch)
}
main().catch(e => console.error('ERR', e))
