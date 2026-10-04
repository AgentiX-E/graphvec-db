import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  // seed: CREATE (:X) CREATE (:Y)
  const nodes: any[] = [{_label:'X'},{_label:'Y'}]
  // query: MATCH (x:X), (y:Y) CREATE (x)<-[:R]-(y)
  const q = `MATCH (x:X), (y:Y) CREATE (x)<-[:R]-(y)`
  const plan = parseQuery(q) as any
  console.log('createEdges =', JSON.stringify(plan.createEdges))
  await _executeQuery(plan, nodes, q)
  console.log('nodes after =', JSON.stringify(nodes))
  // control: MATCH (x:X)<-[:R]-(y:Y) RETURN x,y
  const cq = `MATCH (x:X)<-[:R]-(y:Y) RETURN x, y`
  const cplan = parseQuery(cq) as any
  console.log('control steps =', JSON.stringify(cplan.steps))
  const res: any = await _executeQuery(cplan, nodes, cq)
  console.log('control result =', JSON.stringify(res))
}
main().catch(e => console.error('ERR', e))
