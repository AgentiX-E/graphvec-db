import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  const q = `MATCH (n) WITH [123, n] AS list RETURN (list[1]).missing, (list[1]).missingToo, (list[1]).existing`
  const plan = parseQuery(q) as any
  console.log('with.columns =', JSON.stringify(plan.with?.columns, null, 2))
  console.log('withChain =', JSON.stringify(plan.withChain?.map((w:any)=>w.columns), null, 2))
  console.log('expressionColumns =', JSON.stringify(plan.expressionColumns, null, 2))
}
main().catch(e => { console.error('ERR', e) })
