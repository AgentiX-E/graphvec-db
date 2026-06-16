import * as qm from '../src/query/query-engine'
import * as geMod from '../src/core/graph-engine'
import * as path from 'path'
import * as crypto from 'crypto'
import * as fs from 'fs'

async function main() {
  // Test expression evaluation
  console.log('eval 1 <= 1:', (qm as any)._evalBinary("1 <= 1"))
  console.log('eval 1 < 1:', (qm as any)._evalBinary("1 < 1"))
  console.log('eval 1 <= 2:', (qm as any)._evalBinary("1 <= 2"))
  console.log('eval 2 < 3:', (qm as any)._evalBinary("2 < 3"))
  console.log('eval 1 <= 2 < 3:', (qm as any)._evalBinary("1 <= 2 < 3"))
  console.log('eval 1 <= 1 < 3:', (qm as any)._evalBinary("1 <= 1 < 3"))

  // Test full query execution for both [1] and [3]
  const dir = path.join('/tmp', 'cmp5-' + process.pid)
  fs.mkdirSync(dir, {recursive: true})
  const ge = new geMod.GraphEngine({ path: dir, denseVector: { dimension: 384 } })
  ge.open()

  for (const i of [1, 2, 3]) {
    let h = 0; for (let ci = 0; ci < 'Default'.length; ci++) h = ((h << 5) - h + 'Default'.charCodeAt(ci)) | 0
    ;(ge as any).upsertNode(Math.abs(h) % 1000 + 1, 'sn-' + crypto.randomBytes(2).toString('hex'), { props: { _label: 'Default', num: i } })
  }

  const allNodes = ge.scanAllNodes().map((n: any) => ({...n.props}))
  
  for (const [label, q] of [
    ["[1] 1 < n.num < 3", "MATCH (n) WHERE 1 < n.num < 3 RETURN n.num"],
    ["[3] 1 <= n.num < 3", "MATCH (n) WHERE 1 <= n.num < 3 RETURN n.num"],
  ]) {
    try {
      const plan = qm.parseQuery(q)
      console.log(`\n${label}:`)
      console.log('  whereBody:', plan.whereBody)
      const r = await qm._executeQuery(plan, allNodes, q)
      console.log('  result:', r?.length, JSON.stringify(r))
    } catch(e: any) {
      console.log(`  ERROR: ${e.message}`)
    }
  }
}
main()
