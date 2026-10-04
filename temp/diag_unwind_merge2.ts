import { parseQuery, _executeQuery } from '../src/query/query-engine'
// TCK [6] 精确查询（参数已替换）
const q = `UNWIND [{"year":2016,"id":1},{"year":2016,"id":2}] AS event MATCH (y:Year {year: event.year}) MERGE (e:Event {id: event.id}) MERGE (y)<-[:IN]-(e) RETURN e.id AS x ORDER BY x`
const plan = parseQuery(q)
console.log('type:', plan.type)
_executeQuery(plan, [], q).then(r => {
  console.log('result:', JSON.stringify(r))
}).catch(e => console.log('ERR:', e.message))
