import { parseQuery } from '../src/query/query-parser'
async function main() {
  const q = `WITH [1,2,3] AS list WITH any(x IN list WHERE false) AS result RETURN result`
  const plan = parseQuery(q) as any
  console.log('type =', plan.type)
  console.log('hasMatch =', plan.hasMatch)
  console.log('unwind =', JSON.stringify(plan.unwind))
  console.log('unwinds =', JSON.stringify(plan.unwinds))
  console.log('steps =', JSON.stringify(plan.steps))
  console.log('callProcedure =', plan.callProcedure)
  console.log('with.columns =', JSON.stringify(plan.with.columns))
  console.log('expressionColumns =', JSON.stringify(plan.expressionColumns))
}
main().catch(e => console.error('ERR', e))
