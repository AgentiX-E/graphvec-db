import { parseQuery } from '../src/query/query-parser'

async function main() {
  for (const q of [
    `MATCH (dur2:DurTwo) RETURN 1`,
    `MATCH (dur2: DurTwo) RETURN 1`,
    `MATCH (dur:DurOne), (dur2: DurTwo) RETURN 1`,
  ]) {
    const plan = parseQuery(q) as any
    console.log('q=', JSON.stringify(q), '=> scanLabel=', JSON.stringify(plan.scanLabel), 'multiMatch=', JSON.stringify(plan.multiMatch), 'labelExpr=', plan.labelExpr)
  }
}
main().catch(e => console.error('ERR', e))
