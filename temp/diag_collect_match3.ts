import { parseQuery } from '../src/query/query-engine'
const q = `MATCH (row) WITH collect(row) AS rows UNWIND rows AS node RETURN node.id`
const plan = parseQuery(q)
const wcAgg = (plan as any).with?.aggregate
console.log('with.aggregate:', JSON.stringify(wcAgg))
const colM = wcAgg && typeof wcAgg.column === 'string' ? wcAgg.column.match(/^collect\s*\(\s*([A-Za-z_]\w*)\s*\)/i) : null
console.log('collectM:', JSON.stringify(colM))
console.log('function:', wcAgg?.function)
