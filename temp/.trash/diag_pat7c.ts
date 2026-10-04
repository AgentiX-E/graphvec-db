import { parseQuery } from '../src/query/query-parser'

const q = `MATCH p = (n:X)-->() RETURN n, [x IN nodes(p) | size([(x)-->(:Y) | 1])] AS list`
async function main() {
  const plan = parseQuery(q) as any
  console.log('hasMatch =', plan.hasMatch)
  console.log('pathVariable =', JSON.stringify(plan.pathVariable))
  console.log('steps =', JSON.stringify(plan.steps))
  console.log('scanLabel =', plan.scanLabel)
  console.log('range =', JSON.stringify(plan.range))
  console.log('returnColumns =', JSON.stringify(plan.returnColumns))
}
main().catch(e => console.error('ERR', e))
