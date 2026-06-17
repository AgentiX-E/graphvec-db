const { parseCypherToPlan } = require('./src/query/ast-to-plan-v2');

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
console.log('unwind.name:', plan.unwind ? plan.unwind.name : 'null');
console.log('secondUnwind.name:', plan.secondUnwind ? plan.secondUnwind.name : 'null');
if (plan.unwinds) {
  plan.unwinds.forEach(function(u, i) {
    console.log('unwinds[' + i + '].name:', u.name, 'var:', u.var);
  });
}
console.log('with.columns:');
if (plan.with && plan.with.columns) {
  plan.with.columns.forEach(function(c) {
    console.log('  expression:', c.expression, 'alias:', c.alias);
  });
}
