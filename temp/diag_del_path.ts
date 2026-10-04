import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  const nodes: any[] = [
    {_label:'X', _alias:'x', __edges:[{srcIdx:0,dstIdx:1,label:'R'},{srcIdx:0,dstIdx:2,label:'R'},{srcIdx:0,dstIdx:3,label:'R'}]},
    {_label:null, __edges:[{srcIdx:0,dstIdx:1,label:'R'}]},
    {_label:null, __edges:[{srcIdx:0,dstIdx:2,label:'R'}]},
    {_label:null, __edges:[{srcIdx:0,dstIdx:3,label:'R'}]},
  ]
  const q = `MATCH (n:X) DELETE n`
  const plan = parseQuery(q) as any
  console.log('plan.type =', plan.type)
  console.log('scanLabel =', plan.scanLabel)
  console.log('deleteTargets =', JSON.stringify(plan.deleteTargets))
  try {
    const res: any = await _executeQuery(plan, nodes, q)
    console.log('NO ERROR, result =', JSON.stringify(res))
  } catch(e: any) {
    console.log('CAUGHT:', e.message, 'tckError=', e.tckError)
  }
}
main().catch(e => console.error('ERR', e))
