import { parseQuery } from '../src/query/query-parser'

async function main() {
  const q1 = `MATCH (n:X) DELETE n`
  const p1 = parseQuery(q1) as any
  console.log('q1 type=', p1.type, 'detachDelete=', p1.detachDelete)
  console.log('q1 deleteClauses=', JSON.stringify(p1.deleteClauses))
  console.log('q1 deleteTargets=', JSON.stringify(p1.deleteTargets))
  console.log('q1 steps=', JSON.stringify(p1.steps))

  const q2 = `MATCH (a)-[r]-(b) DELETE r, a, b RETURN count(*) AS c`
  const p2 = parseQuery(q2) as any
  console.log('q2 type=', p2.type, 'detachDelete=', p2.detachDelete)
  console.log('q2 deleteClauses=', JSON.stringify(p2.deleteClauses))
  console.log('q2 deleteTargets=', JSON.stringify(p2.deleteTargets))
  console.log('q2 steps=', JSON.stringify(p2.steps))
}
main().catch(e => console.error('ERR', e))
