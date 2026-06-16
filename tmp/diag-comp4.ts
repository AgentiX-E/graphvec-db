import * as qm from '../src/query/query-engine'
import * as geMod from '../src/core/graph-engine'
import * as path from 'path'
import * as crypto from 'crypto'
import * as fs from 'fs'

async function main() {
  // Simulate TCK: CREATE via GE first, then MATCH
  const dir = path.join('/tmp', 'c3-tck2-' + process.pid)
  fs.mkdirSync(dir, {recursive: true})
  const ge = new geMod.GraphEngine({ path: dir, denseVector: { dimension: 384 } })
  ge.open()

  // Setup like seedGe does
  for (const i of [1, 2, 3]) {
    const node = { _label: 'Default', num: i }
    let h = 0; for (let ci = 0; ci < 'Default'.length; ci++) h = ((h << 5) - h + 'Default'.charCodeAt(ci)) | 0
    ;(ge as any).upsertNode(Math.abs(h) % 1000 + 1, 'sn-' + crypto.randomBytes(2).toString('hex'), { props: { ...node } })
  }

  // Use allNodes from GE scan
  // SKIP _clearGeInstances

  // Register this GE as active
  (qm as any)._geInstanceRegistry.set('test', ge)

  try {
    const q = "MATCH (n) WHERE 1 < n.num < 3 RETURN n.num"
    const plan = qm.parseQuery(q)
    console.log('scanLabel:', plan.scanLabel)
    console.log('steps:', JSON.stringify(plan.steps))
    console.log('filters:', JSON.stringify(plan.filters))
    console.log('whereBody:', plan.whereBody)

    // Use GE directly to execute plan
    const raw = (ge as any)._executeQueryPlan(plan)
    console.log('GE raw result:', raw?.length, JSON.stringify(raw?.map((r: any) => r.props)))

    const r = await qm._executeQuery(plan, allNodes, q)
    console.log('result:', r?.length, JSON.stringify(r))
  } catch(e: any) {
    console.error('ERROR:', e.message)
    console.error(e.stack?.slice(0,500))
  }
}
main()
