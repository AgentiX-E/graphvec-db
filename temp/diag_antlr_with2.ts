import { default as antlr4 } from 'antlr4'
import { CypherLexer, CypherParser } from '@neo4j-cypher/antlr4'

const q = `MATCH p = (n:A)-->() WITH [x IN collect(p) | head(nodes(x))] AS p, count(n) AS c RETURN p, c`
const is = new antlr4.InputStream(q)
const lexer = new CypherLexer(is)
const tokens = new antlr4.CommonTokenStream(lexer)
const parser = new CypherParser(tokens)
parser.buildParseTrees = true
const tree = parser.cypher()

function findWith(node: any): any {
  if (!node) return null
  if (node.constructor?.name === 'WithClauseContext') return node
  for (const c of node.children||[]) { const r = findWith(c); if (r) return r }
  return null
}
const wctx = findWith(tree)
console.log('WithClauseContext.getText() =', JSON.stringify(wctx?.getText()))
console.log('full tree getText() =', JSON.stringify(tree.getText()))
