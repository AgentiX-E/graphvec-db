process.env.COLLECTDBG = '1'
import { parseQuery, _executeQuery } from '../src/query/query-engine'
const q = `MATCH (row) WITH collect(row) AS rows UNWIND rows AS node RETURN node.id`
const plan = parseQuery(q)
const nodes = [{_label:'Default', id:1, _alias:'row'}, {_label:'Default', id:2, _alias:'row'}]
_executeQuery(plan, nodes as any, q).then(r => console.log('FINAL result:', JSON.stringify(r))).catch(e=>console.log('ERR:', e.message))
