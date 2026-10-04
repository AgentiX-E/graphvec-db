import { parseQuery } from '../src/query/query-engine'
const q = `MATCH (a:A)-[:KNOWS]->(b)-->(c) OPTIONAL MATCH (a)-[r:FOLLOWS]->(c) WITH c WHERE r IS NULL RETURN c.name`
const plan: any = parseQuery(q)
console.log('whereBody:', JSON.stringify(plan.whereBody))
console.log('with:', JSON.stringify(plan.with))
console.log('withChain:', JSON.stringify(plan.withChain))
console.log('filters:', JSON.stringify(plan.filters))
console.log('optionalMatchSteps:', JSON.stringify(plan.optionalMatchSteps))
console.log('expressionColumns:', JSON.stringify(plan.expressionColumns))
console.log('returnItems:', JSON.stringify(plan.returnItems || plan.return))
console.log('hasMatch:', plan.hasMatch, 'aggregate:', plan.aggregate)
