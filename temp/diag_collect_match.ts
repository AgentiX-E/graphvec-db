import { parseQuery, _executeQuery } from '../src/query/query-engine'
const q = `MATCH (row) WITH collect(row) AS rows UNWIND rows AS node RETURN node.id`
const plan = parseQuery(q)
console.log('type:', plan.type, 'hasMatch:', plan.hasMatch)
console.log('unwind:', JSON.stringify(plan.unwind), 'unwinds:', JSON.stringify((plan as any).unwinds))
console.log('with:', JSON.stringify(plan.with)?.slice(0, 200))
console.log('aggregate:', JSON.stringify((plan as any).aggregate))
const nodes = [{_label:'Default', id:1, _alias:'row'}, {_label:'Default', id:2, _alias:'row'}]
_executeQuery(plan, nodes as any, q).then(r => console.log('result:', JSON.stringify(r))).catch(e=>console.log('ERR:', e.message))
