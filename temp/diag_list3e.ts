import { _evaluateExpression } from '../src/query/expression-engine'

// 模拟 rowValue 逻辑
function rowValue(row: any, field: string): unknown {
  const f = field
  const fComplex = /^(?!\w+\.\w+$).*[()+\-*/]/.test(f) && f !== '*'
  if (f === '*' || f === '' || f === null) return row
  if (fComplex) return _evaluateExpression(f, row)
  const fVar = f.includes('.') ? f.split('.')[0] : f
  const fProp = f.includes('.') ? f.split('.').pop()! : null
  const owner = row[fVar]
  if (fProp && owner && typeof owner === 'object') return owner[fProp]
  if (f === 'count' || f === '*') return row
  return owner
}

const row = { stop: 3, step: 2, list: [0,2,4] }
console.log("rowValue('stop > 0') =", JSON.stringify(rowValue(row, 'stop > 0')))
console.log("rowValue('stop') =", JSON.stringify(rowValue(row, 'stop')))
console.log("eval 'stop > 0' =", JSON.stringify(_evaluateExpression('stop > 0', row)))
