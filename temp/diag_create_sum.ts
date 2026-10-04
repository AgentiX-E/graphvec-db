import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  const q = `UNWIND [1, 2, 3, 4, 5] AS x CREATE (n:N {num: x}) RETURN sum(n.num) AS sum`
  const plan = parseQuery(q) as any
  console.log('plan.type =', plan.type)
  console.log('plan.aggregate =', JSON.stringify(plan.aggregate))
  console.log('plan.unwind =', JSON.stringify(plan.unwind))
  console.log('plan.unwinds =', JSON.stringify(plan.unwinds))
  console.log('plan.createNodes =', JSON.stringify(plan.createNodes))
  console.log('plan.groupBy =', JSON.stringify(plan.groupBy))
  try {
    const res: any = await _executeQuery(plan, [], q)
    console.log('result =', JSON.stringify(res))
  } catch(e:any) { console.log('CAUGHT:', e.message) }
}
main().catch(e => console.error('ERR', e))
