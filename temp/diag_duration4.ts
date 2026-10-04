import { _evalBinary } from '../src/query/expression-engine'
import { _isExprValue } from '../src/query/query-parser'

async function main() {
  const raw = "duration({years: 12, months: 5, days: 14, hours: 16, minutes: 12, seconds: 70, nanoseconds: 1})"
  console.log('isExprValue =', _isExprValue(raw))
  try {
    const r = _evalBinary(raw, {})
    console.log('eval =', JSON.stringify(r))
  } catch(e:any) {
    console.log('eval ERR:', e.message)
    console.log('stack:', e.stack?.split('\n').slice(0,5).join('\n'))
  }
}
main().catch(e => console.error('ERR', e))
