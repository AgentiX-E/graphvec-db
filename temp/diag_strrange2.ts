import { parseQuery } from '../src/query/query-parser'

async function main() {
  const plan = parseQuery(`MATCH (n) WHERE 'a' < n.name < 'c' RETURN n.name`) as any
  console.log('keys:', Object.keys(plan))
  console.log('filters =', JSON.stringify(plan.filters))
  console.log('whereBody =', JSON.stringify(plan.whereBody))
  console.log('steps =', JSON.stringify(plan.steps?.map((s:any)=>({source:s.source,sourceLabel:s.sourceLabel}))))
  console.log('hasMatch =', plan.hasMatch)
}
main().catch(e => console.error('ERR', e))
