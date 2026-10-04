import { parseQuery, _executeQuery } from '../src/query/query-engine'
const q = `UNWIND [{"year":2016,"id":1},{"year":2016,"id":2}] AS event RETURN event`
const plan = parseQuery(q)
_executeQuery(plan, [], q).then(r => {
  console.log('result:', JSON.stringify(r))
})
