import { parseQuery } from '../src/query/query-engine'
import { _executeWithUnwindPipeline } from '../src/query/executor-unwind-pipeline'
const q = `MATCH (row) WITH collect(row) AS rows UNWIND rows AS node RETURN node.id`
const plan = parseQuery(q)
const node1 = {_label:'Default', id:1}, node2 = {_label:'Default', id:2}
// 模拟 line 1874 fold 后的单行 result
const ctx = { rows: [node1, node2], row: node1 }
const rows = _executeWithUnwindPipeline(plan as any, [ctx], q, ctx)
console.log('rows=[n1,n2] ctx ->', JSON.stringify(rows))
