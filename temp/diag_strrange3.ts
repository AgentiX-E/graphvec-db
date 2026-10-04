import { _evaluateExpression } from '../src/query/expression-engine'

async function main() {
  const ctx = { n: { name: 'b' } }
  console.log("'a' < n.name < 'c' b =", _evaluateExpression("'a' < n.name < 'c'", ctx))
  console.log("'a' < n.name =", _evaluateExpression("'a' < n.name", ctx))
  console.log("n.name < 'c' =", _evaluateExpression("n.name < 'c'", ctx))
  const ctx2 = { n: { name: 'a' } }
  console.log("'a' < n.name < 'c' a =", _evaluateExpression("'a' < n.name < 'c'", ctx2))
}
main().catch(e => console.error('ERR', e))
