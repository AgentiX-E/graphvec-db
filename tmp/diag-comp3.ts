import * as qm from '../src/query/query-engine'
import * as geMod from '../src/core/graph-engine'
import * as path from 'path'
import * as crypto from 'crypto'
import * as fs from 'fs'

async function main() {
  const dir = path.join('/tmp', 'c3-tck-' + process.pid)
  fs.mkdirSync(dir, {recursive: true})
  const ge = new geMod.GraphEngine({ path: dir, denseVector: { dimension: 384 } })
  ge.open()

  let h = 0; for (let ci = 0; ci < 'Default'.length; ci++) h = ((h << 5) - h + 'Default'.charCodeAt(ci)) | 0
  const labelId = Math.abs(h) % 1000 + 1

  for (const i of [1, 2, 3]) {
    (ge as any).upsertNode(labelId, 'sn-' + crypto.randomBytes(2).toString('hex'), { props: { _label: 'Default', num: i } })
  }
  const allNodes = ge.scanAllNodes().map((n: any) => ({...n.props}))
  await (qm as any)._clearGeInstances('test')

  try {
    const q = "MATCH (n) WHERE 1 < n.num < 3 RETURN n.num"
    const plan = qm.parseQuery(q)
    console.log('plan:', JSON.stringify(plan))
    const r = await qm._executeQuery(plan, allNodes, q)
    console.log('result:', r?.length, JSON.stringify(r))
  } catch(e: any) {
    console.error('ERROR:', e.message)
    console.error(e.stack?.slice(0,300))
  }
}
main()
