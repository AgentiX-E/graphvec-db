import { parseQuery } from '../src/query/query-parser'

async function main() {
  for (const q of [
    `MATCH (dur:DurOne), (dur2:DurTwo) RETURN dur.date AS s`,
    `MATCH (dur:DurOne), (dur2: DurTwo) RETURN dur.date AS s`,
  ]) {
    const plan = parseQuery(q) as any
    console.log('--- q:', q.slice(20,50))
    console.log('  multiMatch =', JSON.stringify(plan.multiMatch))
    console.log('  steps =', JSON.stringify(plan.steps))
  }
}
main().catch(e => console.error('ERR', e))
