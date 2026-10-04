import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'
import { _executeWithUnwindPipeline } from '../src/query/executor-unwind-pipeline'

// Monkey-patch to trace calls
const orig = (globalThis as any).__execP
const q = `WITH [1,2,3] AS inputList
UNWIND inputList AS x
WITH inputList, x, [ y IN inputList WHERE rand() > 0.5 | y] AS list
WITH inputList, CASE WHEN rand() < 0.5 THEN reverse(list) ELSE list END + x AS list
WITH any(x IN list WHERE false) AS result, count(*) AS cnt
RETURN result`

async function main() {
  const plan = parseQuery(q) as any
  console.log('plan.hasMatch =', plan.hasMatch, 'plan.unwind =', !!plan.unwind, 'plan.unwinds =', !!plan.unwinds?.length)
  const res: any = await _executeQuery(plan, [], q)
  console.log('FINAL rows =', res.length, JSON.stringify(res))
}
main().catch(e => console.error('ERR', e))
