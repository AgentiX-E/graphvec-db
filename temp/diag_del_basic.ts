import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'
async function main() {
  const nodes: any[] = [{_label:null, _alias:'n0'}]
  const q = `MATCH (n) DELETE n`
  const plan = parseQuery(q) as any
  console.log('scanLabel =', plan.scanLabel, 'type =', plan.type, 'deleteTargets =', JSON.stringify(plan.deleteTargets))
  try {
    const res: any = await _executeQuery(plan, nodes, q)
    console.log('result =', JSON.stringify(res))
    console.log('nodes after =', JSON.stringify(nodes))
  } catch(e: any) { console.log('CAUGHT', e.message, e.tckError) }
}
main().catch(e => console.error('ERR', e))
