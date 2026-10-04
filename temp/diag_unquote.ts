import { _resolveUnwindList } from '../src/query/query-parser'
import { _evaluateExpression } from '../src/query/expression-engine'

async function main() {
  console.log("_evaluateExpression(\"'a'\") =", JSON.stringify(_evaluateExpression("'a'", {})))
  console.log("_resolveUnwindList list ['a','b','c'] =", JSON.stringify(_resolveUnwindList({ list: ["'a'","'b'","'c'"], var: undefined, name: 'c' } as any, {})))
}
main().catch(e => console.error('ERR', e))
