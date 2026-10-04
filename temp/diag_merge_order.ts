import { parseQuery } from '../src/query/query-engine'
const q = `UNWIND $events AS event
MATCH (y:Year {year: event.year})
MERGE (e:Event {id: event.id})
MERGE (y)<-[:IN]-(e)
RETURN e.id AS x
ORDER BY x`
try {
  const plan = parseQuery(q.replace(/\$events/g, '[[{year:2016,id:1},{year:2016,id:2}]]'))
  console.log('parsed OK type=', plan.type, 'unwind=', !!plan.unwind, 'mergeNodes=', (plan as any).createNodes?.length)
} catch (e: any) {
  console.log('parse ERR:', e.message)
}
