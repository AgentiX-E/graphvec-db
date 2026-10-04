import { default as antlr4 } from 'antlr4'
import { CypherLexer, CypherParser } from '@neo4j-cypher/antlr4'

function getTextRecursive(node: any): string {
  if (!node) return ''
  if (typeof node.getText === 'function') return node.getText()
  return ''
}

function walk(node: any, depth=0) {
  if (!node) return
  const name = node.constructor?.name ?? ''
  if (name.toLowerCase().includes('returnitem')) {
    console.log('  ReturnItemContext getText() =', JSON.stringify(getTextRecursive(node)))
    // also dump children names
    const kids = (node.children||[]).map((c:any)=>c.constructor?.name ?? '?')
    console.log('    children:', kids.join(','))
  }
  for (const c of node.children||[]) walk(c, depth+1)
}

const q = `MATCH p = (n:A)-->() WITH [x IN collect(p) | head(nodes(x))] AS p, count(n) AS c RETURN p, c`
const is = new antlr4.InputStream(q)
const lexer = new CypherLexer(is)
const tokens = new antlr4.CommonTokenStream(lexer)
const parser = new CypherParser(tokens)
const tree = parser.cypher()
console.log('tree type:', tree.constructor?.name)
walk(tree)
