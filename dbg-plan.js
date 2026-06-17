const { parseCypherToPlan, parseQuery } = require('./src/query/ast-to-plan-v2');

var q = [
  'MATCH p = (n)-[r]->()',
  'WITH [n, r, p, \'\', 1, 3.14, true, null, [], {}] AS types',
  'UNWIND range(0, size(types) - 1) AS i',
  'UNWIND range(0, size(types) - 1) AS j',
  'WITH types[i] AS lhs, types[j] AS rhs',
  'WHERE i <> j',
  'WITH lhs, rhs, lhs >= rhs AS result',
  'WHERE result',
  'RETURN lhs, rhs'
].join('\n');

var plan = parseCypherToPlan(q.trim());
console.log('plan.hasMatch:', plan.hasMatch);
console.log('plan.unwind:', JSON.stringify(plan.unwind));
console.log('plan.secondUnwind:', JSON.stringify(plan.secondUnwind));
console.log('plan.unwinds:', JSON.stringify(plan.unwinds));
console.log('plan.with:', JSON.stringify(plan.with));
console.log('---');
// Also test parseQuery
var plan2 = parseQuery(q.trim());
console.log('parseQuery.hasMatch:', plan2.hasMatch);
console.log('parseQuery.unwind:', JSON.stringify(plan2.unwind));
console.log('parseQuery.secondUnwind:', JSON.stringify(plan2.secondUnwind));
console.log('parseQuery.with:', JSON.stringify(plan2.with));
