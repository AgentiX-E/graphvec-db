import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'
async function main() {
  const nodes: any[] = [
    {_label:'X', _alias:'x', __edges:[{srcIdx:0,dstIdx:1,label:'R'},{srcIdx:0,dstIdx:2,label:'R'},{srcIdx:0,dstIdx:3,label:'R'}]},
    {_label:null, __edges:[{srcIdx:0,dstIdx:1,label:'R'}]},
    {_label:null, __edges:[{srcIdx:0,dstIdx:2,label:'R'}]},
    {_label:null, __edges:[{srcIdx:0,dstIdx:3,label:'R'}]},
  ]
  // 纯 MATCH（无 DELETE）对比
  const qm = `MATCH (n:X) RETURN n`
  const pm = parseQuery(qm) as any
  console.log('MATCH plan scanLabel=', pm.scanLabel, 'steps=', JSON.stringify(pm.steps))
  const rm: any = await _executeQuery(pm, [...nodes], qm)
  console.log('MATCH result =', JSON.stringify(rm).slice(0,150))
}
main().catch(e => console.error('ERR', e))
