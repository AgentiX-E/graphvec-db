import { parseQuery } from '../src/query/query-parser'
import { _evaluateExpression } from '../src/query/expression-engine'

const q = `MATCH p = (n)-[r]->() WITH [n, r, p, '', 1, 3.14, true, null, [], {}] AS types UNWIND range(0, size(types) - 1) AS i UNWIND range(0, size(types) - 1) AS j WITH types[i] AS lhs, types[j] AS rhs WHERE i <> j WITH lhs, rhs, lhs < rhs AS result WHERE result RETURN lhs, rhs`
async function main() {
  const plan = parseQuery(q) as any
  // 模拟 matchVarCtx（MATCH n-[r]->() 之后）
  const n = { _label: 'X', name: 'n', __edges: [{label:'T'}] }
  const r = { _type: 'T', __edgeLabel: 'T' }
  const p = { __path: [n, {}], __pathEdges: [r] }
  const varCtx: any = { n, r, p }
  const expr = "[n, r, p, '', 1, 3.14, true, null, [], {}]"
  try {
    const types = _evaluateExpression(expr, varCtx)
    console.log('types =', JSON.stringify(types))
    console.log('size(types) =', _evaluateExpression('size(types)', { types }))
  } catch(e:any) {
    console.log('ERR', e.message)
  }
}
main().catch(e => console.error('ERR', e))
