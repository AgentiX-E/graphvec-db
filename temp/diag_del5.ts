const expr = '{key: collect(u)}'
const strippedLit = expr.replace(/'[^']*'/g, "'' ").replace(/"[^"]*"/g, '" ')
let withoutAggs = strippedLit
const callRe = /\b(?:count|sum|avg|max|min|collect|stdev|stdevp|percentileCont|percentileDisc)\s*\(/gi
let cm: RegExpExecArray | null
let offset = 0
while ((cm = callRe.exec(strippedLit)) !== null) {
  const start = cm.index + offset
  let depth = 0, j = cm.index + cm[0].length - 1
  for (; j < strippedLit.length; j++) {
    if (strippedLit[j] === '(') depth++
    else if (strippedLit[j] === ')') { depth--; if (depth === 0) break }
  }
  const end = j + 1
  withoutAggs = withoutAggs.slice(0, start) + withoutAggs.slice(end)
  offset -= (end - start)
}
console.log('withoutAggs =', JSON.stringify(withoutAggs))
const bareVar = /\b[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?\b/g
let bm
while ((bm = bareVar.exec(withoutAggs)) !== null) {
  console.log('bareVar match:', JSON.stringify(bm[0]))
}
