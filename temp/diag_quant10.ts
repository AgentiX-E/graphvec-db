import { parseQuery } from '../src/query/query-parser'

const q = `WITH [1,2,3] AS inputList
UNWIND inputList AS x
WITH inputList, x, [ y IN inputList WHERE rand() > 0.5 | y] AS list
WITH inputList, CASE WHEN rand() < 0.5 THEN reverse(list) ELSE list END + x AS list
WITH any(x IN list WHERE false) AS result, count(*) AS cnt
RETURN result`

async function main() {
  const plan = parseQuery(q) as any
  console.log('with.columns =', JSON.stringify(plan.with?.columns))
  console.log('with.aggregate =', JSON.stringify(plan.with?.aggregate))
  console.log('with.aggregates =', JSON.stringify(plan.with?.aggregates))
  console.log('plan.aggregate =', JSON.stringify(plan.aggregate))
  console.log('withChain len =', plan.withChain?.length)
  console.log('withChain =', JSON.stringify(plan.withChain?.map((w:any)=>({cols:w.columns, agg:w.aggregate})), null, 2))
}
main().catch(e => console.error('ERR', e))
