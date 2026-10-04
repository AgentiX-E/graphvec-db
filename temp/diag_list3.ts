import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

const q = `WITH 0 AS start, [1, 2, 500, 1000, 1500] AS stopList, [-1000, -3, -2, -1, 1, 2, 3, 1000] AS stepList
UNWIND stopList AS stop
UNWIND stepList AS step
WITH start, stop, step, range(start, stop, step) AS list
WITH start, stop, step, list, sign(stop-start) <> sign(step) AS empty
RETURN ALL(ok IN collect((size(list) = 0) = empty) WHERE ok) AS okay`

async function main() {
  const plan = parseQuery(q) as any
  console.log('type =', plan.type, 'hasMatch =', plan.hasMatch, 'unwind =', !!plan.unwind, 'unwinds =', plan.unwinds?.length)
  const res: any = await _executeQuery(plan, [], q)
  console.log('result =', JSON.stringify(res))
}
main().catch(e => console.error('ERR', e))
