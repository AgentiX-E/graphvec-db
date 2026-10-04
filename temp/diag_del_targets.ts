import { parseQuery } from '../src/query/query-parser'
async function main() {
  const cases = [
    `MATCH (n:X) DELETE n`,
    `MATCH (:User)-[r]->(:User) WITH {key: r} AS rels DELETE rels.key`,
    `MATCH (u:User) WITH {key: collect(u)} AS nodeMap DETACH DELETE nodeMap.key[0]`,
    `MATCH (:User)-[r]->(:User) WITH {key: {key: collect(r)}} AS rels DELETE rels.key.key[0]`,
  ]
  for (const q of cases) {
    const p = parseQuery(q) as any
    console.log('Q:', q.slice(0,40))
    console.log('  deleteTargets =', JSON.stringify(p.deleteTargets), 'detachDelete =', p.detachDelete, 'type =', p.type, 'scanLabel =', p.scanLabel, 'steps =', JSON.stringify(p.steps?.map((s:any)=>s.edgeVariable)))
  }
}
main().catch(e => console.error('ERR', e))
