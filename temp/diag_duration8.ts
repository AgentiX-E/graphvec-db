import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  // 精确复现真实 resolvedQ（含空格）
  const q = `MATCH (dur:DurOne), (dur2: DurTwo) RETURN dur.date + dur2.date AS sum, dur.date - dur2.date AS diff`
  // 模拟真实 st.nodes（无 __edges）
  const nodes: any[] = [
    { _label: 'DurOne', date: 'P12Y5M14DT16H13M10.000000001S' },
    { _label: 'DurTwo', date: 'P12Y5M14DT16H13M10.000000001S' },
  ]
  const plan = parseQuery(q) as any
  const res: any = await _executeQuery(plan, nodes, q)
  console.log('result =', JSON.stringify(res))
}
main().catch(e => console.error('ERR', e))
