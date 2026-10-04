import { parseQuery, _executeQuery } from '../src/query/query-engine'

function buildGraph() {
  const isTree2 = true
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
    if (!nodes[si].__edges) nodes[si].__edges = []
    nodes[si].__edges.push({ srcIdx: si, dstIdx: ti, label, props: null })
  }
  return nodes
}

async function main() {
  const q = `MATCH (a:A)-[:KNOWS]->(b:X)-->(c:Y) OPTIONAL MATCH (a)-[r:KNOWS]->(c) WITH c WHERE r IS NOT NULL RETURN c.name`
  const nodes = buildGraph()
  const plan:any = parseQuery(q)
  console.log('steps:', JSON.stringify(plan.steps))
  console.log('optionalMatchSteps:', JSON.stringify(plan.optionalMatchSteps))
  console.log('labelFilterItems:', JSON.stringify(plan.labelFilterItems))
  console.log('filters:', JSON.stringify(plan.filters))
  console.log('whereBody:', JSON.stringify(plan.whereBody))
  const res:any[] = await _executeQuery(plan!, nodes, q)
  console.log('=== RESULT ===')
  for (const r of res) console.log('  ', JSON.stringify(r))
}
main()
