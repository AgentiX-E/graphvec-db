import { parseQuery } from '../src/query/query-parser'
async function main() {
  const plan = parseQuery(`UNWIND ['a', 'b', 'c'] AS c CREATE ({name: c})`) as any
  console.log('type =', plan.type)
  console.log('createNodes =', JSON.stringify(plan.createNodes))
  console.log('unwinds =', JSON.stringify(plan.unwinds))
}
main().catch(e => console.error('ERR', e))
