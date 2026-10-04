import { parseQuery } from '../src/query/query-parser'

async function main() {
  const plan = parseQuery(`UNWIND ['a', 'b', 'c'] AS c CREATE ({name: c})`) as any
  console.log('unwinds =', JSON.stringify(plan.unwinds))
  console.log('unwind =', JSON.stringify(plan.unwind))
  console.log('createNodes =', JSON.stringify(plan.createNodes))
}
main().catch(e => console.error('ERR', e))
