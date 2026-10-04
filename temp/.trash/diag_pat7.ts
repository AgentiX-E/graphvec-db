import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  // 构造图
  const nodes = [
    { _label: 'X', n: 1, name: 'n1', __edges: [] },
    { _label: 'Y', name: 'm1', __edges: [] },
    { _label: 'Y', name: 'i1', __edges: [] },
    { _label: 'Y', name: 'i2', __edges: [] },
    { _label: 'X', n: 2, name: 'n2', __edges: [] },
    { name: 'm2', __edges: [] },
    { _label: 'L', name: 'i3', __edges: [] },
    { _label: 'Y', name: 'i4', __edges: [] },
  ]
  // 边: n1-T->m1, m1-T->i1, m1-T->i2, n2-T->m2, m2-T->i3, m2-T->i4
  // 用 __edges 表示（简化），实际需要正确的 seed

  const q = `MATCH p = (n:X)-->() RETURN n, [x IN nodes(p) | size([(x)-->(:Y) | 1])] AS list`
  const plan = parseQuery(q) as any
  console.log('expressionColumns =', JSON.stringify(plan.expressionColumns))
  console.log('returnColumns =', JSON.stringify(plan.returnColumns))

  // 直接测 pattern comprehension 求值
  const { _evaluateExpression } = await import('../src/query/expression-engine')
  console.log('eval size([(x)-->(:Y) | 1]) =', JSON.stringify(_evaluateExpression('size([(x)-->(:Y) | 1])', { x: { _label: 'X', __edges: [{label:'T', dstIdx:1}] } })))
}
main().catch(e => console.error('ERR', e))
