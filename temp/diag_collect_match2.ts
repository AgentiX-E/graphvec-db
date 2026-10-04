import { parseQuery } from '../src/query/query-engine'
import { _executeWithUnwindPipeline } from '../src/query/executor-unwind-pipeline'
const q = `MATCH (row) WITH collect(row) AS rows UNWIND rows AS node RETURN node.id`
const plan = parseQuery(q)
// 模拟 MATCH 结果 2 个节点，看 pipeline 单独调用会怎样
const nodes = [{_label:'Default', id:1}, {_label:'Default', id:2}]
// 单行调用（模拟 block 8945 的逐行）
for (const n of nodes) {
  const ctx = { row: n }
  const rows = _executeWithUnwindPipeline(plan as any, [ctx], q, ctx)
  console.log('row=', n.id, '->', JSON.stringify(rows))
}
// 尝试一次性传所有节点
const ctxAll = { row: nodes }
const rowsAll = _executeWithUnwindPipeline(plan as any, [ctxAll], q, ctxAll)
console.log('ctxAll row=[n1,n2] ->', JSON.stringify(rowsAll))
