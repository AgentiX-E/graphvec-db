import { parseQuery } from '../src/query/query-parser'
import { _evalBinary } from '../src/query/expression-engine'

async function main() {
  // 模拟 step-definitions 里 CREATE 的 props 求值
  const plan = parseQuery(`CREATE (:DurOne {date: duration({years: 12, months: 5, days: 14, hours: 16, minutes: 12, seconds: 70, nanoseconds: 1})})`) as any
  const cn = plan.createNodes[0]
  console.log('createNodes[0].props =', JSON.stringify(cn.props))
  for (const [k, v] of Object.entries(cn.props as any)) {
    const raw = (v && typeof v === 'object' && 'value' in v && v.type) ? v.value : v
    console.log('prop', k, 'raw =', JSON.stringify(raw), 'typeof=', typeof raw)
    // _isExprValue 检查
    const isExpr = /duration\(|date\(|time\(|datetime\(|localdatetime\(|localTime\(|point\(/.test(raw)
    console.log('  isExpr?', isExpr)
    if (isExpr) {
      try { console.log('  eval =', JSON.stringify(_evalBinary(raw, {}))) }
      catch(e:any) { console.log('  eval ERR:', e.message) }
    }
  }
}
main().catch(e => console.error('ERR', e))
