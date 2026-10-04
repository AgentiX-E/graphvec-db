import { parseQuery } from '../src/query/query-parser'

async function main() {
  const plan = parseQuery(`UNWIND ['a', 'b', 'c'] AS c CREATE ({name: c})`) as any
  console.log('unwind.list =', JSON.stringify(plan.unwind?.list))
  console.log('unwind.var =', plan.unwind?.var)
}
main().catch(e => console.error('ERR', e))
