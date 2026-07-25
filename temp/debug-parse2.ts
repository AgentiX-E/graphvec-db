import { parseCypherToPlan } from '../src/query/ast-to-plan-v2'

const q = "MATCH (a)--(b)--(c)--(d)--(a), (b)--(d) WHERE a.id=1 AND c.id=2 RETURN d"
const plan = parseCypherToPlan(q)
console.log('steps:', JSON.stringify(plan.steps.map((s: any) => ({so: s.source, ta: s.targetAlias})), null, 2))
