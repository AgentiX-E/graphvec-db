import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'

async function main() {
  // 简化版：直接测 WITH any(...) AS result, count(*) AS cnt RETURN result
  const q = `WITH [1, 2, 3] AS list WITH any(x IN list WHERE false) AS result, count(*) AS cnt RETURN result`
  const plan = parseQuery(q) as any
  console.log('with.columns =', JSON.stringify(plan.with?.columns))
  console.log('with.aggregates =', JSON.stringify(plan.with?.aggregates))
  const res: any = await _executeQuery(plan, [], q)
  console.log('result =', JSON.stringify(res))
}
main().catch(e => console.error('ERR', e))
