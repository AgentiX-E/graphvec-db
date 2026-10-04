import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  const q = `WITH [1,2,3] AS list WITH any(x IN list WHERE false) AS result RETURN result`
  const plan = parseQuery(q) as any
  const res: any = await _executeQuery(plan, [], q)
  console.log('result =', JSON.stringify(res))
}
main().catch(e => console.error('ERR', e))
