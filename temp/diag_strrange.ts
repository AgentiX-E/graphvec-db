import { parseQuery } from '../src/query/query-parser'
import { _evaluateExpression } from '../src/query/expression-engine'

async function main() {
  const plan = parseQuery(`MATCH (n) WHERE 'a' < n.name < 'c' RETURN n.name`) as any
  console.log('filters =', JSON.stringify(plan.filters))
  // 测试字符串比较
  console.log("'a' < 'b' =", _evaluateExpression("'a' < 'b'", {}))
  console.log("'b' < 'c' =", _evaluateExpression("'b' < 'c'", {}))
  console.log("'a' < 'b' < 'c' =", _evaluateExpression("'a' < 'b' < 'c'", {}))
}
main().catch(e => console.error('ERR', e))
