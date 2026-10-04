import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  // 构建 seed 数据：UNWIND range(0,10) AS i CREATE (s:S) WITH s,i UNWIND range(0,i) AS j CREATE (s)-[:REL]->()
  // 结果为 11 个 S 节点，度数 deg = 0..10
  const nodes: any[] = []
  for (let i = 0; i <= 10; i++) {
    const node: any = { _label: 'S', _id: i }
    node.__edges = []
    for (let j = 0; j <= i; j++) {
      node.__edges.push({ label: 'REL' })
    }
    nodes.push(node)
  }
  const q = `MATCH (n:S) WITH n, size([(n)-->() | 1]) AS deg WHERE deg > 2 WITH deg LIMIT 100 RETURN percentileDisc(0.90, deg), deg`
  try {
    const res: any = await _executeQuery(parseQuery(q) as any, nodes, q)
    console.log('NO ERROR, result =', JSON.stringify(res))
  } catch(e:any) {
    console.log('CAUGHT:', e.message, 'tckError=', e.tckError)
  }
}
main().catch(e => console.error('ERR', e))
