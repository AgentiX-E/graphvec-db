import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  // seed: CREATE ()-[:R]->()
  const nodes: any[] = [
    {_label:null, _alias:'a', __edges:[{srcIdx:0,dstIdx:1,label:'R'}]},
    {_label:null, _alias:'b', __edges:[{srcIdx:0,dstIdx:1,label:'R'}]},
  ]
  const q = `MATCH (a)-[r]-(b) DELETE r, a, b RETURN count(*) AS c`
  const plan = parseQuery(q) as any
  console.log('deleteTargets =', JSON.stringify(plan.deleteTargets))
  console.log('steps =', JSON.stringify(plan.steps))
  const res: any = await _executeQuery(plan, nodes, q)
  console.log('result =', JSON.stringify(res))
  console.log('nodes after =', JSON.stringify(nodes))
}
main().catch(e => console.error('ERR', e))
