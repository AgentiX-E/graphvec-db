import { parseQuery, _executeQuery } from '../src/query/query-engine'
const q = `WITH [0, 1] AS prows, [[2], [3, 4]] AS qrows UNWIND prows AS p UNWIND qrows[p] AS q WITH p, count(q) AS rng RETURN p ORDER BY rng`
const plan = parseQuery(q)
console.log('type:', plan.type, 'hasMatch:', plan.hasMatch, 'unwind:', JSON.stringify(plan.unwind))
console.log('unwinds:', JSON.stringify((plan as any).unwinds))
console.log('with:', JSON.stringify(plan.with)?.slice(0,300))
console.log('orderBy:', JSON.stringify(plan.orderBy))
console.log('aggregate:', JSON.stringify((plan as any).aggregate))
_executeQuery(plan, [] as any, q).then(r => console.log('result:', JSON.stringify(r))).catch(e=>console.log('ERR:', e.message))
