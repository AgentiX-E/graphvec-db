import { parseCypherToPlan } from '/home/admin/openclaw/workspace/agentiX-graphvec/src/query/antlr-bridge'
import { parseQuery } from '/home/admin/openclaw/workspace/agentiX-graphvec/src/query/query-engine'

const qs = [
  'CREATE (:A)',
  'CREATE (:A {name: "test"})',
  'CREATE (:A), (:B {id: 1})',
  'CREATE (:A)-[:KNOWS]->(:B)',
  'MATCH (n) CREATE (:A)',
  'CREATE (n:Person {p: \'foo\'}) RETURN n.p',
]

for (const q of qs) {
  const antlr = parseCypherToPlan(q)
  const plan = parseQuery(q)
  console.log('---')
  console.log('Q:', q.slice(0, 40))
  console.log('ANTLR type:', antlr?.type, 'create:', antlr?.create ? 'yes (' + antlr.create.length + ')' : 'no')
  if (antlr?.create) {
    for (let i = 0; i < antlr.create.length; i++) {
      console.log('  pattern', i, ':', JSON.stringify(antlr.create[i]).substring(0, 200))
    }
  }
  console.log('parseQuery type:', plan?.type, 'create:', plan?.create ? 'yes' : 'no')
  const pp = plan as any
  console.log('  createNodes:', pp?.createNodes?.length ?? 0, 'createEdges:', pp?.createEdges?.length ?? 0)
}
