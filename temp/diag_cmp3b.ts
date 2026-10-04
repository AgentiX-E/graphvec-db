import { _evaluateExpression } from '../src/query/expression-engine'

async function main() {
  // 真实 types 列表：含 null, [], {}
  const tests = [
    "size([1, null, [], {}])",
    "size([null])",
    "range(0, size([1, null, [], {}]) - 1)",
  ]
  for (const t of tests) {
    try {
      console.log(t, '=', JSON.stringify(_evaluateExpression(t, {})))
    } catch(e:any) { console.log(t, 'ERR:', e.message) }
  }
}
main().catch(e => console.error('ERR', e))
