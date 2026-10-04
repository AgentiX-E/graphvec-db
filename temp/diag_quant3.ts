import { parseQuery } from '../src/query/query-parser'
async function main() {
  const q = `WITH [1,2,3] AS list WITH any(x IN list WHERE false) AS result RETURN result`
  const plan = parseQuery(q) as any
  console.log('type =', plan.type)
  console.log('with =', JSON.stringify(plan.with, null, 2))
  console.log('withChain =', JSON.stringify(plan.withChain?.map((w:any)=>w.columns), null, 2))
  console.log('expressionColumns =', JSON.stringify(plan.expressionColumns))
  console.log('aggregate =', JSON.stringify(plan.aggregate))
  console.log('returnColumns =', JSON.stringify(plan.returnColumns))
  console.log('returnAliasMap =', JSON.stringify(plan.returnAliasMap))
}
main().catch(e => console.error('ERR', e))
