import { parseQuery } from '../src/query/query-parser'

const q = `MATCH p = (n)-[r]->() WITH [n, r, p, '', 1, 3.14, true, null, [], {}] AS types UNWIND range(0, size(types) - 1) AS i UNWIND range(0, size(types) - 1) AS j WITH types[i] AS lhs, types[j] AS rhs WHERE i <> j WITH lhs, rhs, lhs < rhs AS result WHERE result RETURN lhs, rhs`
async function main() {
  const plan = parseQuery(q) as any
  console.log('keys:', Object.keys(plan))
  console.log('with.columns =', JSON.stringify(plan.with?.columns))
  console.log('preUnwindWith =', JSON.stringify(plan.preUnwindWith))
  console.log('unwinds =', JSON.stringify(plan.unwinds?.map((u:any)=>u.var)))
  console.log('hasMatch =', plan.hasMatch)
  console.log('steps =', JSON.stringify(plan.steps?.map((s:any)=>s.source)))
}
main().catch(e => console.error('ERR', e))
