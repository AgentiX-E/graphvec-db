import { parseQuery } from '../src/query/query-parser'
import { _executeWithUnwindPipeline } from '../src/query/executor-unwind-pipeline'

const q = `WITH [1,2,3] AS stopList UNWIND stopList AS stop RETURN collect(stop > 0) AS c`
async function main() {
  const plan = parseQuery(q) as any
  console.log('aggregate =', JSON.stringify(plan.aggregate))
  console.log('expressionColumns =', JSON.stringify(plan.expressionColumns))
  const rows = _executeWithUnwindPipeline(plan, [{}] as any, q, {})
  console.log('pipeline rows =', JSON.stringify(rows))
}
main().catch(e => console.error('ERR', e))
