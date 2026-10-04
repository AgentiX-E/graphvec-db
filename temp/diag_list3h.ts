import { parseQuery } from '../src/query/query-parser'

const q = `WITH [1,2,3] AS stopList UNWIND stopList AS stop RETURN ALL(ok IN collect(stop > 0) WHERE ok) AS r`
async function main() {
  const plan = parseQuery(q) as any
  console.log('aggregate =', JSON.stringify(plan.aggregate))
}
main().catch(e => console.error('ERR', e))
