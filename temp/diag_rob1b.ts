import { parseQuery } from '../src/query/query-engine'
import { _executeWithUnwindPipeline } from '../src/query/executor-unwind-pipeline'
const q = `WITH [0, 1] AS prows, [[2], [3, 4]] AS qrows UNWIND prows AS p UNWIND qrows[p] AS q WITH p, count(q) AS rng RETURN p ORDER BY rng`
const plan = parseQuery(q)
const nodes: any[] = []
const rows = _executeWithUnwindPipeline(plan as any, nodes, q)
console.log('pipeline rows:', JSON.stringify(rows))
