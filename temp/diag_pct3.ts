import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  const nodes: any[] = []
  for (let i = 0; i <= 10; i++) {
    const node: any = { _label: 'S', _id: i, __edges: [] }
    for (let j = 0; j <= i; j++) node.__edges.push({ label: 'REL' })
    nodes.push(node)
  }
  const q = `MATCH (n:S) WITH n, size([(n)-->() | 1]) AS deg WHERE deg > 2 WITH deg LIMIT 100 RETURN percentileDisc(0.90, deg), deg`
  const plan = parseQuery(q) as any
  console.log('plan.aggregate =', JSON.stringify(plan.aggregate))
  console.log('plan.type =', plan.type, 'hasMatch =', plan.hasMatch, 'unwind =', plan.unwind)
  // 看 returnColumns 和 expressionColumns
  console.log('returnColumns =', JSON.stringify(plan.returnColumns))
  console.log('expressionColumns =', JSON.stringify(plan.expressionColumns))
}
main().catch(e => console.error('ERR', e))
