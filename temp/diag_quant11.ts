import { parseQuery } from '../src/query/query-parser'
import { _executeWithUnwindPipeline } from '../src/query/executor-unwind-pipeline'

const q = `WITH [1,2,3] AS inputList
UNWIND inputList AS x
WITH inputList, x, [ y IN inputList WHERE rand() > 0.5 | y] AS list
WITH inputList, CASE WHEN rand() < 0.5 THEN reverse(list) ELSE list END + x AS list
WITH any(x IN list WHERE false) AS result, count(*) AS cnt
RETURN result`

async function main() {
  const plan = parseQuery(q) as any
  console.log('plan.unwinds =', JSON.stringify(plan.unwinds))
  const rows = _executeWithUnwindPipeline(plan, [{}] as any, q, {})
  console.log('pipeline rows =', JSON.stringify(rows))
}
main().catch(e => console.error('ERR', e))
