import { _evaluateExpression } from '../src/query/expression-engine'
const followObj = { __edgeLabel: 'FOLLOWS', __edgeLabelStr: 'FOLLOWS', _type: 'FOLLOWS', _label: 'FOLLOWS' }
console.log('r IS NULL (non-null):', _evaluateExpression('r IS NULL', { r: followObj }))
console.log('r IS NULL (null):', _evaluateExpression('r IS NULL', { r: null }))
console.log('r IS NOT NULL (non-null):', _evaluateExpression('r IS NOT NULL', { r: followObj }))
console.log('r IS NOT NULL (null):', _evaluateExpression('r IS NOT NULL', { r: null }))
