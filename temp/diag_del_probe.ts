const q = `MATCH (n:X) DELETE n`
// 直接调 step-definitions 的 run 逻辑太复杂，用 cucumber 跑单场景并打印 st.err
import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'
async function main() {
  const nodes: any[] = [
    {_label:'X', _alias:'x', __edges:[{srcIdx:0,dstIdx:1,label:'R'},{srcIdx:0,dstIdx:2,label:'R'},{srcIdx:0,dstIdx:3,label:'R'}]},
    {_label:null, __edges:[{srcIdx:0,dstIdx:1,label:'R'}]},
    {_label:null, __edges:[{srcIdx:0,dstIdx:2,label:'R'}]},
    {_label:null, __edges:[{srcIdx:0,dstIdx:3,label:'R'}]},
  ]
  const plan = parseQuery(q) as any
  console.log('hasMatch =', plan.hasMatch, 'scanLabel =', plan.scanLabel, 'steps =', JSON.stringify(plan.steps))
  console.log('deleteTargets =', JSON.stringify(plan.deleteTargets))
  console.log('detachDelete =', plan.detachDelete)
  try {
    const res: any = await _executeQuery(plan, nodes, q)
    console.log('NO ERROR result =', JSON.stringify(res))
    console.log('nodes after =', JSON.stringify(nodes.map(n => n._label)))
  } catch(e: any) { console.log('CAUGHT', e.message, e.tckError) }
}
main().catch(e => console.error('ERR', e))
