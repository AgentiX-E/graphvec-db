import { createTCKEngine, destroyTCKEngine, injectNodes, injectEdge } from '../src/query/cypher-tck/tck-engine-adapter'

async function main() {
  const engine = createTCKEngine()
  const ids = await injectNodes(engine, [
    { _label: 'Person', name: 'Alice' },
    { _label: 'Person', name: 'Bob' },
  ])
  console.log('IDs:', ids)
  await injectEdge(engine, ids[0], ids[1], 'KNOWS')

  // Try engine.query directly
  const r = engine.query('MATCH (a)-[:KNOWS]->(b) RETURN a, b') as any[]
  console.log('raw result count:', r.length)
  if (r.length > 0) {
    for (const rec of r) {
      console.log(`  id=${rec.id} name=${rec.name} props=${JSON.stringify(rec.props)}`)
    }
  }

  // Try tckQuery
  const { tckQuery } = await import('../src/query/cypher-tck/tck-engine-adapter')
  const r2 = tckQuery(engine, 'MATCH (a)-[:KNOWS]->(b) RETURN a, b')
  console.log('tckQuery result count:', r2.length)
  if (r2.length > 0) {
    console.log('  row:', JSON.stringify(r2[0]))
  }

  await destroyTCKEngine(engine)
}

main().catch(console.error)
