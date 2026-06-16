import * as qm from '../src/query/query-engine'
import * as geMod from '../src/core/graph-engine'
import * as path from 'path'
import * as crypto from 'crypto'
import * as fs from 'fs'

async function main() {
  const dir = path.join('/tmp', 'c3-2-' + process.pid)
  fs.mkdirSync(dir, {recursive: true})
  const ge = new geMod.GraphEngine({ path: dir, denseVector: { dimension: 384 } })
  ge.open()

  let h = 0; for (let ci = 0; ci < 'Label'.length; ci++) h = ((h << 5) - h + 'Label'.charCodeAt(ci)) | 0
  const labelId = Math.abs(h) % 1000 + 1

  for (let i = 1; i <= 5; i++) {
    (ge as any).upsertNode(labelId, 'sn-' + crypto.randomBytes(2).toString('hex'), { props: { _label: 'Label', num: i } })
  }
  const allNodes = ge.scanAllNodes().map((n: any) => ({...n.props}))
  await (qm as any)._clearGeInstances('test')

  try {
    const plan = qm.parseQuery("MATCH (n:Label) WHERE n.num > 1 RETURN n.num AS n_num")
    const r = await qm._executeQuery(plan, allNodes, "MATCH (n:Label) WHERE n.num > 1 RETURN n.num AS n_num")
    console.log('result:', r?.length, JSON.stringify(r))
  } catch(e: any) {
    console.error('ERROR:', e.message)
    console.error(e.stack?.slice(0,500))
  }
}
main()
