import { parseQuery } from '../src/query/query-engine'
const q = `UNWIND [{"year":2016,"id":1},{"year":2016,"id":2}] AS event MATCH (y:Year {year: event.year}) MERGE (e:Event {id: event.id}) RETURN e.id AS x`
const plan = parseQuery(q)
console.log('unwind:', JSON.stringify(plan.unwind))
console.log('unwinds:', JSON.stringify((plan as any).unwinds))
