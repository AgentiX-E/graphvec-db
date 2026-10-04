import { parseCypherToPlan } from '../src/query/ast-to-plan-v2'

const q = 'MATCH p = (n:X)-->() RETURN n, [x IN nodes(p) | size([(x)-->(:Y) | 1])] AS list'
const plan = parseCypherToPlan(q)
console.log(JSON.stringify(plan, null, 2))
