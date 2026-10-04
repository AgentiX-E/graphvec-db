import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  // 节点数组（带 __edges），模仿 step-definitions 的 st.nodes 格式
  // n1:X{n:1} -T-> m1:Y; m1 -T-> i1:Y; m1 -T-> i2:Y
  // n2:X{n:2} -T-> m2(无标签); m2 -T-> i3:L; m2 -T-> i4:Y
  const nodes: any[] = [
    { _label: 'X', n: 1, __edges: [{ srcIdx: 0, dstIdx: 1, label: 'T' }] },
    { _label: 'Y', __edges: [{ srcIdx: 1, dstIdx: 2, label: 'T' }, { srcIdx: 1, dstIdx: 3, label: 'T' }] },
    { _label: 'Y', __edges: [] },
    { _label: 'Y', __edges: [] },
    { _label: 'X', n: 2, __edges: [{ srcIdx: 4, dstIdx: 5, label: 'T' }] },
    { __edges: [{ srcIdx: 5, dstIdx: 6, label: 'T' }, { srcIdx: 5, dstIdx: 7, label: 'T' }] },
    { _label: 'L', __edges: [] },
    { _label: 'Y', __edges: [] },
  ]
  const q = `MATCH p = (n:X)-->() RETURN n, [x IN nodes(p) | size([(x)-->(:Y) | 1])] AS list`
  const plan = parseQuery(q) as any
  const res: any = await _executeQuery(plan, nodes, q)
  console.log('result len =', res.length)
  console.log('result =', JSON.stringify(res))
}
main().catch(e => console.error('ERR', e))
