import { parseQuery, _executeQuery } from '../src/query/query-engine'
const q = `UNWIND [{"year":2016,"id":1},{"year":2016,"id":2}] AS event MATCH (y:Year {year: 2016}) MERGE (e:Event {id: event.id}) RETURN e.id AS x ORDER BY x`
// seed Year node
const plan = parseQuery(q)
_executeQuery(plan, [], q).then(r => {
  console.log('result:', JSON.stringify(r))
  // 看 allNodes 里的 Event 节点
})
