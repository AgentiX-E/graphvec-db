import { parseQuery } from '../src/query/query-parser'
async function main() {
  const q = `MATCH p = (n:A)-->() WITH [x IN collect(p) | head(nodes(x))] AS p, count(n) AS c RETURN p, c`
  const plan = parseQuery(q) as any
  console.log('with.columns =', JSON.stringify(plan.with?.columns, null, 2))
}
main().catch(e => console.error('ERR', e))
