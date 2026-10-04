import { parseQuery } from '../src/query/query-parser'
import { _executeQuery } from '../src/query/query-executor'
import { _validatePlan } from '../src/query/executor-validate-plan'

async function main() {
  const q = `MATCH (dur:DurOne), (dur2:DurTwo) RETURN dur.date + dur2.date AS sum, dur.date - dur2.date AS diff`
  const plan = parseQuery(q) as any
  try {
    _validatePlan(plan, q)
    console.log('validate OK')
  } catch(e:any) {
    console.log('validate ERR:', e.message)
  }
}
main().catch(e => console.error('ERR', e))
