// Quick test: parse MW2[1] query and dump steps
import { parseCypherToPlan } from '../src/query/ast-to-plan-v2'

const q = "MATCH (a)--(b)--(c)--(d)--(a), (b)--(d) WHERE a.id=1 AND c.id=2 RETURN d"
const plan = parseCypherToPlan(q)
console.log('steps:', JSON.stringify(plan.steps, null, 2))
console.log('scanLabel:', plan.scanLabel)
