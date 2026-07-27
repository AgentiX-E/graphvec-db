/**
 * MW2 Investigation v7 — Deep trace of GE's _executeQueryPlan
 */

import { createTCKEngine, destroyTCKEngine, injectNodes, injectEdge } from '../src/query/cypher-tck/tck-engine-adapter'

async function main() {
  console.log('='.repeat(80))
  console.log('Deep trace of GE _executeQueryPlan for MW2[2]')
  console.log('='.repeat(80))

  const engine = createTCKEngine()
  try {
    const ids = await injectNodes(engine, [
      { _label: 'Default', name: 'advertiser1', id: 0 },
      { _label: 'Default', name: 'Color', id: 1 },
      { _label: 'Default', name: 'red' },
      { _label: 'Default', name: 'product1' },
      { _label: 'Default', name: 'product4' },
    ])
    await injectEdge(engine, ids[0], ids[3], 'ADV_HAS_PRODUCT')
    await injectEdge(engine, ids[0], ids[4], 'ADV_HAS_PRODUCT')
    await injectEdge(engine, ids[1], ids[2], 'AA_HAS_VALUE')
    await injectEdge(engine, ids[3], ids[2], 'AP_HAS_VALUE')
    await injectEdge(engine, ids[4], ids[2], 'AP_HAS_VALUE')

    // Deep trace
    const engineInner = engine as any
    
    // Trace _executeQueryPlan
    const origExec = engineInner._executeQueryPlan.bind(engineInner)
    engineInner._executeQueryPlan = function(p: any) {
      console.log('\n=== _executeQueryPlan ===')
      console.log(`scanLabel=${p.scanLabel}, steps=${p.steps?.length || 0}, filters=${p.filters?.length || 0}`)
      
      // Trace scan
      const origScanAll = engineInner._scanAll.bind(engineInner)
      engineInner._scanAll = function(lim: any) {
        const r = origScanAll(lim)
        console.log(`  _scanAll(limit=${lim}): ${r.length} nodes`)
        for (const n of r) {
          console.log(`    id=${n.id}, type=${n.typeName}, props=`, JSON.stringify(n.props).slice(0, 100))
        }
        return r
      }

      // Trace the traversal loop
      const origNeighbors = engineInner.storage.neighbors.bind(engineInner.storage)
      engineInner.storage.neighbors = function(nid: any, opts: any) {
        const r = origNeighbors(nid, opts)
        if (r && r.length) {
          console.log(`  storage.neighbors(${nid}, opts=${JSON.stringify(opts)}): ${r.length} entries`)
          for (const e of r) {
            console.log(`    → nodeId=${e.nodeId}, edgeType=${e.edgeTypeId}, direction=${e.direction}`)
          }
        }
        return r
      }

      // Trace _matchFilter
      const origMatchFilter = engineInner._matchFilter.bind(engineInner)
      engineInner._matchFilter = function(node: any, f: any) {
        const nodeVal = node.props?.[f.property]
        const r = origMatchFilter(node, f)
        console.log(`  _matchFilter(node.id=${node.id}, ${f.property} ${f.operator} ${f.value}): node.${f.property}=${nodeVal} → ${r}`)
        return r
      }

      const result = origExec(p)
      console.log(`  RESULT: ${result.length} nodes`)
      for (const n of result) {
        console.log(`    id=${n.id}, props=`, JSON.stringify(n.props).slice(0, 100))
      }
      return result
    }

    // Test
    const query = "MATCH (advertiser)-[:ADV_HAS_PRODUCT]->(out)-[:AP_HAS_VALUE]->(red)<-[:AA_HAS_VALUE]-(a) WHERE advertiser.id = 0 AND a.id = 1 AND red.name = 'red' AND out.name = 'product1' RETURN out.name"
    console.log('Query:', query)
    const r = engine.query(query) as any[]
    console.log(`\nFinal result count: ${r.length}`)

  } finally {
    await destroyTCKEngine(engine)
  }

  console.log('\nDone.')
}

main().catch(e => { console.error(e); process.exit(1) })
