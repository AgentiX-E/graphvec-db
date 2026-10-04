import { parseQuery } from '../src/query/query-engine'
const q = `UNWIND [{"login":"login1","name":"name1"},{"login":"login2","name":"name2"}] AS prop MERGE (p:Person {login: prop.login}) SET p.name = prop.name RETURN p.name, p.login`
const plan = parseQuery(q)
console.log('type:', plan.type)
console.log('setClauses:', JSON.stringify((plan as any).setClauses))
console.log('createNodes:', JSON.stringify((plan as any).createNodes))
