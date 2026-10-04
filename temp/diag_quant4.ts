import { _evaluateExpression } from '../src/query/expression-engine'
async function main() {
  const ctx = { list: [1,2,3] }
  console.log('any false =', JSON.stringify(_evaluateExpression('any(x IN list WHERE false)', ctx)))
  console.log('any true  =', JSON.stringify(_evaluateExpression('any(x IN list WHERE true)', ctx)))
  console.log('any x>2   =', JSON.stringify(_evaluateExpression('any(x IN list WHERE x > 2)', ctx)))
}
main().catch(e => console.error('ERR', e))
