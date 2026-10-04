import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  const cases = [
    `WITH [1,2,3] AS stopList, [1,2] AS stepList UNWIND stopList AS stop UNWIND stepList AS step RETURN collect(stop) AS c`,
    `WITH [1,2,3] AS ls RETURN ALL(x IN ls WHERE x > 0) AS r`,
    `WITH [true, true] AS ls RETURN ALL(x IN ls WHERE x) AS r`,
  ]
  for (const q of cases) {
    const plan = parseQuery(q) as any
    const res: any = await _executeQuery(plan, [], q)
    console.log(JSON.stringify(q), '=>', JSON.stringify(res))
  }
}
main().catch(e => console.error('ERR', e))
