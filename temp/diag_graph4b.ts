import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  const q = `MATCH (n) WITH [123, n] AS list RETURN (list[1]).missing, (list[1]).missingToo, (list[1]).existing`
  const plan = parseQuery(q) as any
  const nodes = [{ _label: 'Default', existing: 42, missing: null, __edges: [] }]
  const res = await _executeQuery(plan, nodes, q)
  console.log('result =', JSON.stringify(res))
}
main().catch(e => { console.error('ERR', e) })
