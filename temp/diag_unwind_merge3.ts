import { parseQuery, _executeQuery } from '../src/query/query-engine'
const qs: [string,string][] = [
  ['only MATCH', `UNWIND [{"year":2016,"id":1},{"year":2016,"id":2}] AS event MATCH (y:Year {year: event.year}) MERGE (e:Event {id: event.id}) RETURN e.id AS x ORDER BY x`],
  ['no MATCH year-event', `UNWIND [{"year":2016,"id":1},{"year":2016,"id":2}] AS event MERGE (e:Event {id: event.id}) RETURN e.id AS x ORDER BY x`],
]
for (const [n,q] of qs) {
  const plan = parseQuery(q)
  _executeQuery(plan, [], q).then(r => console.log(n, '->', JSON.stringify(r))).catch(e=>console.log(n,'ERR',e.message))
}
