import { parseQuery } from '../src/query/query-engine'
import { _executeWithUnwindPipeline } from '../src/query/executor-unwind-pipeline'
const q = `UNWIND RANGE(1, 2) AS row WITH collect(row) AS rows UNWIND rows AS x RETURN x`
const plan = parseQuery(q)
const rows = _executeWithUnwindPipeline(plan as any, [], q)
console.log('pipeline rows:', JSON.stringify(rows))
