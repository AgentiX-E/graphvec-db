import { _splitWithColumns } from '../src/query/query-parser'

const q = `MATCH p = (n)-[r]->() WITH [n, r, p, '', 1, 3.14, true, null, [], {}] AS types UNWIND range(0, size(types) - 1) AS i`
const unwindIdx = q.search(/\bUNWIND\b/i)
const prefix = q.slice(0, unwindIdx)
console.log('prefix =', JSON.stringify(prefix))
const withRegex = /\bWITH\s+(.+?)(?=\s+(?:WITH|UNWIND|RETURN)\b|$)/gis
let m
while ((m = withRegex.exec(prefix)) !== null) {
  const clauseBody = m[1].trim()
  console.log('clauseBody =', JSON.stringify(clauseBody))
  const columns = _splitWithColumns(clauseBody)
  console.log('columns =', JSON.stringify(columns, null, 2))
}
