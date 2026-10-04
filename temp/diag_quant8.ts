import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  const cases = [
    `WITH [1,2,3] AS inputList UNWIND inputList AS x WITH inputList, x, [y IN inputList WHERE rand() > 0.5 | y] AS list WITH any(x IN list WHERE false) AS result, count(*) AS cnt RETURN result`,
    `WITH [1,2] AS inputList UNWIND inputList AS x WITH any(x IN inputList WHERE false) AS result, count(*) AS cnt RETURN result`,
  ]
  for (const q of cases) {
    const plan = parseQuery(q) as any
    const res: any = await _executeQuery(plan, [], q)
    console.log('---')
    console.log(JSON.stringify(q))
    console.log('=>', JSON.stringify(res))
  }
}
main().catch(e => console.error('ERR', e))
