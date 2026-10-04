import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  const nodes: any[] = [{_label:'X'},{_label:'Y'}]
  const q = `MATCH (x:X), (y:Y) CREATE (x)<-[:R]-(y)`
  const plan = parseQuery(q) as any
  await _executeQuery(plan, nodes, q)
  console.log('nodes =', JSON.stringify(nodes))
}
main().catch(e => console.error('ERR', e))
