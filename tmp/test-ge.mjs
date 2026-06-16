import * as mod from '../src/query/query-engine.js'
import * as geMod from '../src/core/graph-engine.js'
import * as path from 'path'
import * as crypto from 'crypto'
import * as fs from 'fs'

const dir = path.join('/tmp', 'ge-chk-' + process.pid)
fs.mkdirSync(dir, {recursive: true})
const ge = new geMod.GraphEngine({ path: dir, denseVector: { dimension: 384 } })
ge.open()

const nodes = [
  {_label: 'TheLabel', name: 'ABCDEF'}, {_label: 'TheLabel', name: 'AB'},
  {_label: 'TheLabel', name: 'abcdef'}, {_label: 'TheLabel', name: 'ab'},
  {_label: 'TheLabel', name: ''}, {_label: 'TheLabel'},
  {_label: 'TheLabel', name: ' Foo '}, {_label: 'TheLabel', name: '\nFoo\n'},
]
let h = 0; for (let ci = 0; ci < 'TheLabel'.length; ci++) h = ((h << 5) - h + 'TheLabel'.charCodeAt(ci)) | 0
for (const n of nodes) (ge as any).upsertNode(Math.abs(h) % 1000 + 1, 'sn-' + Math.random().toString(36).slice(2, 6), { props: { ...n } })

const planForGe = { type: 'QUERY', scanLabel: 'TheLabel', steps: [], filters: [{ source: 'a', property: 'name', operator: 'STARTS_WITH', value: ' ' }], hasMatch: true, returnColumns: ['a'] }
const raw = (ge as any)._executeQueryPlan(planForGe)
console.log('GE returned:', raw?.length, 'nodes')
for (const r of raw) { console.log('  node:', JSON.stringify(r.props?.name || r.props)) }

// Now test _executeQuery
import('./src/query/query-engine.js').then(async qm => {
  const allNodes = raw.map((n: any) => ({...n.props}))
  await (qm as any)._clearGeInstances('test')
  const r = await qm._executeQuery(planForGe, allNodes, "MATCH (a:TheLabel) WHERE a.name STARTS WITH ' ' RETURN a.name AS name")
  console.log('_executeQuery result:', r?.length, r ? JSON.stringify(r) : 'null')
})
