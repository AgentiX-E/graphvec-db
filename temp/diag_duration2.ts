import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  // 先 CREATE 节点（模拟 seed）
  const q1 = `CREATE (:DurOne {date: duration({years: 12, months: 5, days: 14, hours: 16, minutes: 12, seconds: 70, nanoseconds: 1})}), (:DurTwo {date: duration({years: 12, months: 5, days: 14, hours: 16, minutes: 12, seconds: 70, nanoseconds: 1})})`
  const nodes: any[] = []
  await _executeQuery(parseQuery(q1) as any, nodes, q1)
  console.log('after CREATE nodes =', JSON.stringify(nodes))

  // 查询
  const q2 = `MATCH (dur:DurOne), (dur2:DurTwo) RETURN dur.date + dur2.date AS sum, dur.date - dur2.date AS diff`
  const res: any = await _executeQuery(parseQuery(q2) as any, nodes, q2)
  console.log('result =', JSON.stringify(res))
}
main().catch(e => console.error('ERR', e))
