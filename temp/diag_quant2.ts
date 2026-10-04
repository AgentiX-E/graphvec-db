import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  const cases = [
    `WITH [1,2,3] AS list RETURN any(x IN list WHERE false) AS r`,
    `WITH [1,2,3] AS list RETURN any(x IN list WHERE true) AS r`,
    `WITH [1,2,3] AS list WITH any(x IN list WHERE false) AS result RETURN result`,
    `WITH [1,2,3] AS list WITH any(x IN list WHERE false) AS result, count(*) AS cnt RETURN result, cnt`,
  ]
  for (const q of cases) {
    const plan = parseQuery(q) as any
    const res: any = await _executeQuery(plan, [], q)
    console.log(JSON.stringify(q), '=>', JSON.stringify(res))
  }
}
main().catch(e => console.error('ERR', e))
