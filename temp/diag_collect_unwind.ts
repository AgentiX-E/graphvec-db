import { parseQuery, _executeQuery } from '../src/query/query-engine'
const q = `UNWIND RANGE(1, 2) AS row WITH collect(row) AS rows UNWIND rows AS x RETURN x`
const plan = parseQuery(q)
console.log('type:', plan.type)
console.log('unwinds:', JSON.stringify((plan as any).unwinds))
console.log('withChain:', JSON.stringify((plan as any).withChain || plan.with)?.slice(0, 400))
_executeQuery(plan, [], q).then(r => {
  console.log('result:', JSON.stringify(r))
}).catch(e => console.log('ERR:', e.message))
