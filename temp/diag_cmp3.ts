import { _evaluateExpression, _evalBinary } from '../src/query/expression-engine'

async function main() {
  const types = [{_label:'X'}, {_type:'T'}, {__path:[]}, '', 1, 3.14, true, null, [], {}]
  const ctx: any = { types }
  console.log('size(types) =', JSON.stringify(_evaluateExpression('size(types)', ctx)))
  console.log('size(types)-1 =', JSON.stringify(_evaluateExpression('size(types) - 1', ctx)))
  try {
    console.log('range(0, size(types)-1) =', JSON.stringify(_evaluateExpression('range(0, size(types) - 1)', ctx)))
  } catch(e:any) { console.log('range ERR:', e.message) }
}
main().catch(e => console.error('ERR', e))
