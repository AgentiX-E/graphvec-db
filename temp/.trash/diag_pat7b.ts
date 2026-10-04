import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'
import { GraphEngine } from '../src/core/graph-engine'

async function main() {
  const ge = new GraphEngine()
  // n1:X{n:1} -T-> m1:Y; m1 -T-> i1:Y; m1 -T-> i2:Y
  // n2:X{n:2} -T-> m2(无标签); m2 -T-> i3:L; m2 -T-> i4:Y
  const n1 = ge.upsertNode({ _label: 'X', n: 1 }) as any
  const m1 = ge.upsertNode({ _label: 'Y' }) as any
  const i1 = ge.upsertNode({ _label: 'Y' }) as any
  const i2 = ge.upsertNode({ _label: 'Y' }) as any
  const n2 = ge.upsertNode({ _label: 'X', n: 2 }) as any
  const m2 = ge.upsertNode({}) as any
  const i3 = ge.upsertNode({ _label: 'L' }) as any
  const i4 = ge.upsertNode({ _label: 'Y' }) as any
  // edges
  const edges = [[n1,m1],[m1,i1],[m1,i2],[n2,m2],[m2,i3],[m2,i4]]
  for (const [s,t] of edges) ge.createEdge(s, t, 'T', {})

  const q = `MATCH p = (n:X)-->() RETURN n, [x IN nodes(p) | size([(x)-->(:Y) | 1])] AS list`
  const plan = parseQuery(q) as any
  const allNodes = ge.getAllNodes()
  console.log('allNodes len =', allNodes.length)
  const res: any = await _executeQuery(plan, allNodes, q)
  console.log('result =', JSON.stringify(res))
}
main().catch(e => console.error('ERR', e))
