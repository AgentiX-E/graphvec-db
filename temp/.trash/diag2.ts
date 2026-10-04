import { parseQuery, _executeQuery } from '../src/query/query-engine'

function buildGraph(variant: 'binary-tree-1'|'binary-tree-2' = 'binary-tree-1') {
  const isTree2 = variant === 'binary-tree-2'
  const leafLabel = (name: string) => (isTree2 && ['c12','c22','c32','c42'].includes(name)) ? 'Y' : 'X'
  const idx = new Map<string, number>()
  const nodes: any[] = []
  const addNode = (name: string, label: string) => { idx.set(name, nodes.length); nodes.push({ _label: label, name }) }
  addNode('a','A')
  for (const n of ['b1','b2','b3','b4']) addNode(n,'X')
  for (const n of ['c11','c12','c21','c22','c31','c32','c41','c42']) addNode(n, leafLabel(n))
  const edges: [string,string,string][] = [
    ['a','b1','KNOWS'],['a','b2','KNOWS'],['a','b3','FOLLOWS'],['a','b4','FOLLOWS'],
    ['b1','c11','FRIEND'],['b1','c12','FRIEND'],['b2','c21','FRIEND'],['b2','c22','FRIEND'],
    ['b3','c31','FRIEND'],['b3','c32','FRIEND'],['b4','c41','FRIEND'],['b4','c42','FRIEND'],
    ['b1','b2','FRIEND'],['b2','b3','FRIEND'],['b3','b4','FRIEND'],['b4','b1','FRIEND'],
  ]
  for (const [s,t,label] of edges) {
    const si = idx.get(s)!, ti = idx.get(t)!
    const src = nodes[si]
    if (!src.__edges) src.__edges = []
    src.__edges.push({ srcIdx: si, dstIdx: ti, label, props: null })
  }
  return nodes
}

async function run(q: string, variant: 'binary-tree-1'|'binary-tree-2' = 'binary-tree-1') {
  const nodes = buildGraph(variant)
  const plan = parseQuery(q)
  const res = await _executeQuery(plan!, nodes, q)
  return res
}

async function main() {
  // Scenario 3
  const q3 = `MATCH (a:A)-[:KNOWS]->(b)-->(c) OPTIONAL MATCH (a)-[r:FOLLOWS]->(c) WITH c WHERE r IS NULL RETURN c.name`
  const res3:any[] = await run(q3)
  console.log('=== [3] r IS NULL, FOLLOWS ===')
  for (const r of res3) console.log('  row:', JSON.stringify(r))
}
main()
