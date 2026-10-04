import { parseQuery, _executeQuery } from '../src/query/query-engine'
const q = `UNWIND [{"login":"login1","name":"name1"},{"login":"login2","name":"name2"}] AS prop MERGE (p:Person {login: prop.login}) SET p.name = prop.name RETURN p.name, p.login`
const plan = parseQuery(q)
_executeQuery(plan, [], q).then(r => {
  console.log('result:', JSON.stringify(r))
}).catch(e => console.log('ERR:', e.message))
