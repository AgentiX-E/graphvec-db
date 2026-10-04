import { parseQuery } from '../src/query/query-parser'

const q = `MATCH p = (n)-[r]->() WITH [n, r, p, '', 1, 3.14, true, null, [], {}] AS types UNWIND range(0, size(types) - 1) AS i UNWIND range(0, size(types) - 1) AS j WITH types[i] AS lhs, types[j] AS rhs WHERE i <> j WITH lhs, rhs, lhs < rhs AS result WHERE result RETURN lhs, rhs`
async function main() {
  const plan = parseQuery(q) as any
  console.log('withChain =', JSON.stringify(plan.withChain, null, 2))
  console.log('pathVar =', JSON.stringify(plan.pathVar))
  console.log('matchVar =', JSON.stringify(plan.matchVar))
}
main().catch(e => console.error('ERR', e))
