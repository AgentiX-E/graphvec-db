import { parseQuery } from '../src/query/query-parser'
import { _executeWithUnwindPipeline } from '../src/query/executor-unwind-pipeline'

const q = `MATCH p = (n)-[r]->() WITH [n, r, p, '', 1, 3.14, true, null, [], {}] AS types UNWIND range(0, size(types) - 1) AS i UNWIND range(0, size(types) - 1) AS j WITH types[i] AS lhs, types[j] AS rhs WHERE i <> j WITH lhs, rhs, lhs < rhs AS result WHERE result RETURN lhs, rhs`
async function main() {
  const plan = parseQuery(q) as any
  // 构造 matchVarCtx（模拟 MATCH 阶段产物）
  const n = { _label: 'X', name: 'n', __edges: [{label:'T', dstIdx:1}] }
  const r = { _type: 'T', __edgeLabel: 'T' }
  const p = { __path: [n, {}], __pathEdges: [r] }
  const matchVarCtx: any = { n, r, p }
  plan.hasMatch = true
  try {
    const rows = _executeWithUnwindPipeline(plan, [matchVarCtx] as any, q, matchVarCtx)
    console.log('rows len =', rows.length)
  } catch(e:any) {
    console.log('ERR', e.message)
  }
}
main().catch(e => console.error('ERR', e))
