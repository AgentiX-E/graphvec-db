import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

const q = `WITH [1, null, true, 4.5, 'abc', false, '', [234, false], {a: null, b: true, c: 15.2}, {}, [], [null], [[{b: [null]}]]] AS inputList
UNWIND inputList AS x
WITH inputList, x, [ y IN inputList WHERE rand() > 0.5 | y] AS list
WITH inputList, CASE WHEN rand() < 0.5 THEN reverse(list) ELSE list END + x AS list
UNWIND inputList AS x
WITH inputList, x, [ y IN inputList WHERE rand() > 0.5 | y] AS list
WITH inputList, CASE WHEN rand() < 0.5 THEN reverse(list) ELSE list END + x AS list
UNWIND inputList AS x
WITH inputList, x, [ y IN inputList WHERE rand() > 0.5 | y] AS list
WITH inputList, CASE WHEN rand() < 0.5 THEN reverse(list) ELSE list END + x AS list
WITH list WHERE size(list) > 0
WITH any(x IN list WHERE false) AS result, count(*) AS cnt
RETURN result`

async function main() {
  const plan = parseQuery(q) as any
  const res: any = await _executeQuery(plan, [], q)
  console.log('rows =', res.length)
  console.log('result =', JSON.stringify(res))
}
main().catch(e => console.error('ERR', e))
