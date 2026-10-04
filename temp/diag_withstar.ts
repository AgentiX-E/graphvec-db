import { parseQuery } from '../src/query/query-parser'
async function main() {
  const q = `MATCH (p:Person { name: '42' }) WITH * MATCH (n) RETURN toInteger(n.name) AS name`
  const plan = parseQuery(q) as any
  console.log('with.columns =', JSON.stringify(plan.with?.columns, null, 2))
  console.log('with =', JSON.stringify(plan.with, null, 2))
}
main().catch(e => console.error('ERR', e))
