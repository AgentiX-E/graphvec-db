// 直接调用 parseQuery 内部的 parse，dump NodeLabelContext
import { parseQuery } from '../src/query/query-parser'

async function main() {
  const q = `MATCH (dur2: DurTwo) RETURN 1`
  const plan = parseQuery(q) as any
  console.log('scanLabel=', JSON.stringify(plan.scanLabel), 'multiMatch=', JSON.stringify(plan.multiMatch))
  // 也测 label 带多空格
  const q2 = `MATCH (dur2:DurTwo) RETURN 1`
  const plan2 = parseQuery(q2) as any
  console.log('q2 scanLabel=', JSON.stringify(plan2.scanLabel))
}
main().catch(e => console.error('ERR', e))
