import { _evaluateExpression } from '../src/query/expression-engine'

async function main() {
  // duration 字面量
  try {
    const d1 = _evaluateExpression("duration({years: 12, months: 5, days: 14, hours: 16, minutes: 12, seconds: 70, nanoseconds: 1})", {})
    console.log('d1 =', JSON.stringify(d1), 'typeof=', typeof d1)
    if (d1 && typeof d1 === 'object') console.log('d1 keys=', Object.keys(d1))
  } catch(e:any) { console.log('duration ERR:', e.message) }

  // duration 相加
  try {
    const sum = _evaluateExpression("duration({years:1}) + duration({years:2})", {})
    console.log('sum =', JSON.stringify(sum))
  } catch(e:any) { console.log('sum ERR:', e.message) }
}
main().catch(e => console.error('ERR', e))
