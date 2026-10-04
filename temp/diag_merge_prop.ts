import { parseQuery } from '../src/query/query-engine'
const q1 = `UNWIND $props AS prop MERGE (p:Person {login: prop.login}) SET p.name = prop.name RETURN p.name, p.login`
const q2 = `UNWIND $events AS event MATCH (y:Year {year: event.year}) MERGE (e:Event {id: event.id}) MERGE (y)<-[:IN]-(e) RETURN e.id AS x ORDER BY x`
for (const [n, q] of [['q1', q1], ['q2', q2]] as const) {
  const plan = parseQuery(q.replace(/\$props|\$events/g, '[]'))
  console.log('\n===', n, '===')
  console.log('createNodes:', JSON.stringify((plan as any).createNodes, null, 0).slice(0, 500))
  console.log('mergeNodes:', JSON.stringify((plan as any).mergeNodes).slice(0, 300))
  console.log('setClauses:', JSON.stringify((plan as any).setClauses || (plan as any).set).slice(0, 300))
  console.log('unwind:', JSON.stringify(plan.unwind).slice(0, 200))
  console.log('unwinds:', JSON.stringify((plan as any).unwinds).slice(0, 200))
}
