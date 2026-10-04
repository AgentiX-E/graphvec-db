import { parseQuery, _executeQuery } from '../src/query/query-engine'
(globalThis as any).__TCK_DEBUG_WHERE = true
function buildGraph() {
  const idx = new Map<string, number>()
  const nodes: any[] = []
  const addNode = (name: string, label: string) => { idx.set(name, nodes.length); nodes.push({ _label: label, name }) }
  addNode('a','A')
  for (const n of ['b1','b2','b3','b4']) addNode(n,'X')
  for (const n of ['c11','c12','c21','c22','c31','c32','c41','c42']) addNode(n, 'X')
  const edges: [string,string,string][] = [
    ['a','b1','KNOWS'],['a','b2','KNOWS'],['a','b3','FOLLOWS'],['a','b4','FOLLOWS'],
    ['b1','c11','FRIEND'],['b1','c12','FRIEND'],['b2','c21','FRIEND'],['b2','c22','FRIEND'],
    ['b3','c31','FRIEND'],['b3','c32','FRIEND'],['b4','c41','FRIEND'],['b4','c42','FRIEND'],
    ['b1','b2','FRIEND'],['b2','b3','FRIEND'],['b3','b4','FRIEND'],['b4','b1','FRIEND'],
  ]
  for (const [s,t,label] of edges) {
    const si = idx.get(s)!, ti = idx.get(t)!
    if (!nodes[si].__edges) nodes[si].__edges = []
    nodes[si].__edges.push({ srcIdx: si, dstIdx: ti, label, props: null })
  }
  return nodes
}
async function main() {
  const q = `MATCH (a:A)-[:KNOWS]->(b)-->(c) OPTIONAL MATCH (a)-[r:FOLLOWS]->(c) WITH c WHERE r IS NULL RETURN c.name`
  const nodes = buildGraph()
  const plan = parseQuery(q)
  const res:any[] = await _executeQuery(plan!, nodes, q)
  console.log('=== FINAL ===')
  for (const r of res) console.log('  ', JSON.stringify(r.name ?? r['c.name'] ?? r))
}
main()
