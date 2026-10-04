import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'
import { clearGeInstances } from '../src/query/query-engine'

async function main() {
  const q = `UNWIND [1, 2, 3, 4, 5] AS x CREATE (n:N {num: x}) RETURN sum(n.num) AS sum`
  const plan = parseQuery(q) as any
  // 模拟 step-definitions 的 nodes 为空 + run 流程
  const nodes: any[] = []
  try {
    const res: any = await _executeQuery(plan, nodes, q)
    console.log('result =', JSON.stringify(res))
    console.log('nodes after =', JSON.stringify(nodes))
  } catch(e:any) { console.log('CAUGHT:', e.message) }
}
main().catch(e => console.error('ERR', e))
