import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  const cases = [
    `WITH [1,2,3] AS stopList UNWIND stopList AS stop RETURN ALL(x IN collect(stop > 0) WHERE x) AS r`,
    `WITH [1,2,3] AS stopList UNWIND stopList AS stop RETURN collect(stop > 0) AS c`,
  ]
  for (const q of cases) {
    const plan = parseQuery(q) as any
    const res: any = await _executeQuery(plan, [], q)
    console.log(JSON.stringify(q), '=>', JSON.stringify(res))
  }
}
main().catch(e => console.error('ERR', e))
