import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  // seed: CREATE (x:X); CREATE (x)-[:R]->() x3
  const nodes: any[] = [
    {_label:'X', _alias:'x', __edges:[{srcIdx:0,dstIdx:1,label:'R'},{srcIdx:0,dstIdx:2,label:'R'},{srcIdx:0,dstIdx:3,label:'R'}]},
    {_label:null, __edges:[{srcIdx:0,dstIdx:1,label:'R'}]},
    {_label:null, __edges:[{srcIdx:0,dstIdx:2,label:'R'}]},
    {_label:null, __edges:[{srcIdx:0,dstIdx:3,label:'R'}]},
  ]
  const q = `MATCH (n:X) DELETE n`
  const plan = parseQuery(q) as any
  console.log('deleteTargets =', JSON.stringify(plan.deleteTargets))
  console.log('detachDelete =', plan.detachDelete)
  const res: any = await _executeQuery(plan, nodes, q)
  console.log('result =', JSON.stringify(res))
  console.log('nodes after =', JSON.stringify(nodes))
}
main().catch(e => console.error('ERR', e))
