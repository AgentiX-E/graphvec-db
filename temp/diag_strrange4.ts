import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  const nodes: any[] = [
    { _label: 'Default', name: 'a', __edges: [] },
    { _label: 'Default', name: 'b', __edges: [] },
    { _label: 'Default', name: 'c', __edges: [] },
  ]
  const q = `MATCH (n) WHERE 'a' < n.name < 'c' RETURN n.name`
  const plan = parseQuery(q) as any
  const res: any = await _executeQuery(plan, nodes, q)
  console.log('result =', JSON.stringify(res))
}
main().catch(e => console.error('ERR', e))
