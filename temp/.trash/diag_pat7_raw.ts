import { parseQuery, _executeQuery } from '../src/query/query-engine'

async function main() {
  const nodes: any[] = []
  const push = (label: string, props: Record<string, any>) => {
    const node: any = { _label: label, ...props }
    nodes.push(node)
    return nodes.length - 1
  }
  const edge = (src: number, dst: number, label: string) => {
    const s = nodes[src]
    if (!s.__edges) s.__edges = []
    s.__edges.push({ srcIdx: src, dstIdx: dst, label, props: null })
  }
  const n1 = push('X', { n: 1 })
  const m1 = push('Y', {})
  const i1 = push('Y', {})
  const i2 = push('Y', {})
  edge(n1, m1, 'T'); edge(m1, i1, 'T'); edge(m1, i2, 'T')
  const n2 = push('X', { n: 2 })
  const m2 = push('', {})
  const i3 = push('L', {})
  const i4 = push('Y', {})
  edge(n2, m2, 'T'); edge(m2, i3, 'T'); edge(m2, i4, 'T')

  const q = 'MATCH p = (n:X)-->() RETURN n'
  const plan = parseQuery(q)
  const res = await _executeQuery(plan, nodes, q)
  // res is array of rows; print __crossVarRows / props of each
  console.log(JSON.stringify(res, null, 2))
}

main().catch(e => { console.error(e); process.exit(1) })
